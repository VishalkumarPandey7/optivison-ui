from __future__ import annotations

from dataclasses import dataclass
from math import hypot
from typing import Any


@dataclass(frozen=True)
class Zone:
    id: str
    name: str
    x: float
    y: float
    width: float
    height: float
    coordinate_space: str = "percent"


class SignalRuleEngine:
    """Stateful, model-agnostic signal and rule evaluator.

    The engine does not know about Ultralytics. It consumes normalized detector
    observations, turns them into named signals, and evaluates time-aware rules.
    This keeps the rule layer reusable when a different detector is added later.
    """

    def __init__(self) -> None:
        self._previous_keypoints: dict[tuple[str, str], list[tuple[float, float, float]]] = {}
        self._signal_last_seen: dict[tuple[str, str], float] = {}
        self._rule_started_at: dict[tuple[str, str], float] = {}
        self._zone_membership: dict[tuple[str, str], set[str]] = {}
        self._cumulative_counts: dict[tuple[str, str], int] = {}
        self._previous_signal_active: dict[tuple[str, str], bool] = {}
        self._sequence_progress: dict[tuple[str, str], int] = {}
        self._sequence_started_at: dict[tuple[str, str], float] = {}

    def reset(self, camera_id: str | None = None) -> None:
        if camera_id is None:
            self._previous_keypoints.clear()
            self._signal_last_seen.clear()
            self._rule_started_at.clear()
            self._zone_membership.clear()
            self._cumulative_counts.clear()
            self._previous_signal_active.clear()
            self._sequence_progress.clear()
            self._sequence_started_at.clear()
            return

        self._previous_keypoints = {
            key: value for key, value in self._previous_keypoints.items() if key[0] != camera_id
        }
        self._signal_last_seen = {
            key: value for key, value in self._signal_last_seen.items() if key[0] != camera_id
        }
        self._rule_started_at = {
            key: value for key, value in self._rule_started_at.items() if key[0] != camera_id
        }
        self._zone_membership = {
            key: value for key, value in self._zone_membership.items() if key[0] != camera_id
        }
        self._cumulative_counts = {
            key: value for key, value in self._cumulative_counts.items() if key[0] != camera_id
        }
        self._previous_signal_active = {
            key: value for key, value in self._previous_signal_active.items() if key[0] != camera_id
        }
        self._sequence_progress = {
            key: value for key, value in self._sequence_progress.items() if key[0] != camera_id
        }
        self._sequence_started_at = {
            key: value for key, value in self._sequence_started_at.items() if key[0] != camera_id
        }

    def evaluate(
        self,
        *,
        camera_id: str,
        timestamp: float,
        width: int,
        height: int,
        detections: list[dict[str, Any]],
        zones: list[dict[str, Any]],
        signal_definitions: list[dict[str, Any]],
        rules: list[dict[str, Any]],
        zone_metrics: dict[str, dict[str, Any]] | None = None,
        counting_metrics: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        parsed_zones = {zone.id: zone for zone in (parse_zone(item) for item in zones)}
        motion_scores = self._calculate_motion_scores(camera_id, width, height, detections)
        signal_states = [
            self._evaluate_signal(
                camera_id=camera_id,
                timestamp=timestamp,
                width=width,
                height=height,
                detections=detections,
                zones=parsed_zones,
                motion_scores=motion_scores,
                zone_metrics=zone_metrics or {},
                counting_metrics=counting_metrics or {},
                definition=definition,
            )
            for definition in signal_definitions
        ]
        states_by_id = {state["signalId"]: state for state in signal_states}
        rule_states = [
            self._evaluate_rule(camera_id, timestamp, states_by_id, rule)
            for rule in rules
        ]
        return {
            "signals": signal_states,
            "rules": rule_states,
            "outputs": [state["output"] for state in rule_states if state["active"]],
        }

    def _evaluate_signal(
        self,
        *,
        camera_id: str,
        timestamp: float,
        width: int,
        height: int,
        detections: list[dict[str, Any]],
        zones: dict[str, Zone],
        motion_scores: dict[str, float],
        zone_metrics: dict[str, dict[str, Any]],
        counting_metrics: dict[str, dict[str, Any]],
        definition: dict[str, Any],
    ) -> dict[str, Any]:
        signal_id = str(definition.get("id") or "signal")
        name = str(definition.get("name") or signal_id)
        kind = str(definition.get("kind") or "object_detected")
        class_name = str(definition.get("className") or "person").lower()
        minimum_confidence = clamp(float(definition.get("confidence", 0.35)), 0, 1)
        source_task = str(definition.get("sourceTask") or "").strip()
        zone_id = str(definition.get("zoneId") or "").strip()
        zone = zones.get(zone_id)

        if definition.get("analysisEnabled", True) is False:
            self._signal_last_seen.pop((camera_id, signal_id), None)
            self._previous_signal_active.pop((camera_id, signal_id), None)
            return {
                "signalId": signal_id,
                "name": name,
                "kind": kind,
                "active": False,
                "rawActive": False,
                "held": False,
                "stateChanged": False,
                "value": False,
                "confidence": 0.0,
                "timestamp": timestamp,
                "evidence": {
                    "summary": "Disabled by this camera's selected analysis ROI scope",
                    "className": class_name,
                    "zoneId": zone_id or None,
                    "trackIds": [],
                    "spatialEngine": "analysis-roi-scope",
                },
            }

        candidates = [
            detection
            for detection in detections
            if str(detection.get("className", "")).lower() == class_name
            and float(detection.get("confidence", 0)) >= minimum_confidence
            and (not source_task or str(detection.get("task", "")) == source_task)
        ]
        in_zone = [
            detection
            for detection in candidates
            if zone is None or detection_inside_zone(detection, zone, width, height)
        ]

        value: bool | int | float = False
        raw_active = False
        confidence = max((float(item.get("confidence", 0)) for item in in_zone), default=0.0)
        evidence: dict[str, Any] = {
            "kind": kind,
            "className": class_name,
            "candidateCount": len(candidates),
            "inZoneCount": len(in_zone),
            "zoneId": zone_id or None,
            "trackIds": [str(item.get("trackId")) for item in in_zone],
            "spatialEngine": (
                next(
                    (str(item["spatialEngine"]) for item in candidates if item.get("spatialEngine")),
                    "box-center-fallback",
                )
                if zone else None
            ),
        }

        if kind == "object_detected":
            raw_active = len(candidates) > 0
            value = raw_active
            evidence["summary"] = f"{len(candidates)} {class_name} detection(s) above confidence threshold"
        elif kind == "object_in_roi":
            raw_active = zone is not None and len(in_zone) > 0
            value = raw_active
            evidence["summary"] = (
                f"{len(in_zone)} {class_name} detection(s) inside {zone.name}"
                if zone
                else "ROI is not configured"
            )
        elif kind == "object_count":
            threshold = max(1, int(definition.get("countThreshold", 1)))
            count = len(in_zone if zone else candidates)
            raw_active = count >= threshold
            value = count
            evidence.update({"count": count, "countThreshold": threshold})
            evidence["summary"] = f"Count {count} compared with required {threshold}"
        elif kind in {"line_crossing_count", "line_crossing_rate"}:
            metric = counting_metrics.get(signal_id, {})
            configured = bool(metric.get("configured", False))
            inbound_count = max(0, int(metric.get("inboundCount", 0)))
            outbound_count = max(0, int(metric.get("outboundCount", 0)))
            total_count = max(0, int(metric.get("totalCount", inbound_count + outbound_count)))
            crossed_this_frame = max(0, int(metric.get("crossedThisFrame", 0)))
            rate_per_minute = max(0.0, float(metric.get("ratePerMinute", 0.0)))
            raw_active = configured and (rate_per_minute > 0 if kind == "line_crossing_rate" else crossed_this_frame > 0)
            value = round(rate_per_minute, 2) if kind == "line_crossing_rate" else total_count
            confidence = 1.0 if raw_active else 0.0
            evidence.update({
                "configured": configured,
                "lineId": metric.get("lineId") or definition.get("lineId"),
                "inboundCount": inbound_count,
                "outboundCount": outbound_count,
                "totalCount": total_count,
                "count": total_count,
                "lastDirection": metric.get("lastDirection"),
                "crossedThisFrame": crossed_this_frame,
                "ratePerMinute": round(rate_per_minute, 2),
                "crossingEvents": list(metric.get("crossingEvents") or []),
                "crossings": list(metric.get("crossings") or []),
                "liveTracks": list(metric.get("liveTracks") or []),
                "motionMask": metric.get("motionMask"),
                "foregroundPercent": max(0.0, float(metric.get("foregroundPercent", 0.0))),
                "countingMode": metric.get("countingMode", "direct-motion-zone"),
                "trackingEngine": metric.get("trackingEngine", "direct-centroid-motion-tracker"),
                "spatialEngine": metric.get("spatialEngine", "background-subtraction-motion-zone"),
            })
            if not configured:
                evidence["summary"] = "Draw and activate the Counting Zone to make direct motion counting ready"
            elif kind == "line_crossing_rate":
                evidence["summary"] = f"Current output rate {rate_per_minute:.1f} pass(es) per minute"
            elif crossed_this_frame:
                direction = str(metric.get("lastDirection") or "crossing")
                evidence["summary"] = f"Motion object passed · total {total_count} · {direction}"
            else:
                live_count = len(metric.get("liveTracks") or [])
                foreground = max(0.0, float(metric.get("foregroundPercent", 0.0)))
                evidence["summary"] = f"Total {total_count} passed · {live_count} live motion track(s) · foreground {foreground:.1f}%"
        elif kind == "object_absent_from_roi":
            raw_active = zone is not None and len(in_zone) == 0
            value = raw_active
            evidence["summary"] = (
                f"No {class_name} detected inside {zone.name}"
                if zone
                else "ROI is not configured"
            )
        elif kind == "objects_near":
            secondary_class = str(definition.get("secondaryClass") or "cell phone").lower()
            secondary_candidates = [
                detection
                for detection in detections
                if str(detection.get("className", "")).lower() == secondary_class
                and float(detection.get("confidence", 0)) >= minimum_confidence
                and (not source_task or str(detection.get("task", "")) == source_task)
            ]
            secondary_in_zone = [
                detection
                for detection in secondary_candidates
                if zone is None or detection_inside_zone(detection, zone, width, height)
            ]
            max_distance = max(0.0, float(definition.get("maxDistancePercent", 18.0)))
            diagonal = max(1.0, hypot(width, height))
            pairs = []
            for primary in in_zone:
                for secondary in secondary_in_zone:
                    primary_center = box_center(primary.get("box", [0, 0, 0, 0]))
                    secondary_center = box_center(secondary.get("box", [0, 0, 0, 0]))
                    distance = hypot(
                        primary_center[0] - secondary_center[0],
                        primary_center[1] - secondary_center[1],
                    ) / diagonal * 100
                    if distance <= max_distance:
                        pairs.append({
                            "primaryTrackId": str(primary.get("trackId")),
                            "secondaryTrackId": str(secondary.get("trackId")),
                            "distancePercent": round(distance, 3),
                        })
            raw_active = zone is not None and len(pairs) > 0
            value = raw_active
            confidence = max(
                (
                    min(float(primary.get("confidence", 0)), float(secondary.get("confidence", 0)))
                    for primary in in_zone
                    for secondary in secondary_in_zone
                ),
                default=0.0,
            )
            evidence.update({
                "secondaryClass": secondary_class,
                "secondaryCount": len(secondary_in_zone),
                "maxDistancePercent": max_distance,
                "pairs": pairs,
            })
            evidence["summary"] = (
                f"{len(pairs)} {class_name}/{secondary_class} close pair(s) inside {zone.name}"
                if zone
                else "ROI is not configured"
            )
        elif kind in {"zone_motion", "zone_idle"}:
            threshold = max(0.0, float(definition.get("motionThreshold", 1.0)))
            metric = zone_metrics.get(zone_id, {})
            initialized = bool(metric.get("initialized", False))
            score = max(0.0, float(metric.get("motionScore", 0.0)))
            raw_active = initialized and (score >= threshold if kind == "zone_motion" else score < threshold)
            value = round(score, 4)
            evidence.update({
                "motionScore": round(score, 4),
                "motionThreshold": threshold,
                "initialized": initialized,
            })
            state_name = "moving" if kind == "zone_motion" else "idle"
            evidence["summary"] = (
                f"{zone.name} is {state_name}: motion {score:.3f}, threshold {threshold:.3f}"
                if zone and initialized
                else "Waiting for two frames to measure ROI motion" if zone else "ROI is not configured"
            )
        elif kind == "roi_color_match":
            metric = zone_metrics.get(zone_id, {})
            average_rgb = list(metric.get("averageRgb") or [0, 0, 0])
            target_color = str(definition.get("targetColor") or "#22c55e")
            target_rgb = parse_hex_color(target_color)
            tolerance = max(1.0, float(definition.get("colorTolerance", 55.0)))
            distance = hypot(
                hypot(float(average_rgb[0]) - target_rgb[0], float(average_rgb[1]) - target_rgb[1]),
                float(average_rgb[2]) - target_rgb[2],
            ) if len(average_rgb) >= 3 else 999.0
            configured = zone is not None and len(average_rgb) >= 3
            raw_active = configured and distance <= tolerance
            value = round(distance, 2)
            confidence = clamp(1.0 - distance / max(1.0, tolerance * 2), 0.0, 1.0) if configured else 0.0
            evidence.update({
                "averageColor": metric.get("averageColor", "#000000"),
                "targetColor": target_color,
                "colorDistance": round(distance, 2),
                "colorTolerance": tolerance,
                "controlledCondition": True,
            })
            evidence["summary"] = (
                f"{zone.name} average {evidence['averageColor']} compared with controlled target {target_color}"
                if zone else "Color-check ROI is not configured"
            )
        elif kind == "object_orientation_match":
            expected = str(definition.get("expectedOrientation") or "landscape")
            match = None
            orientation = None
            aspect_ratio = 0.0
            if in_zone:
                box = in_zone[0].get("box") or [0, 0, 0, 0]
                box_width = max(0.0, float(box[2]) - float(box[0]))
                box_height = max(0.0, float(box[3]) - float(box[1]))
                aspect_ratio = box_width / max(1.0, box_height)
                orientation = "square" if 0.85 <= aspect_ratio <= 1.18 else "landscape" if aspect_ratio > 1.18 else "portrait"
                match = orientation == expected
            raw_active = bool(match)
            value = round(aspect_ratio, 3)
            evidence.update({"orientation": orientation, "expectedOrientation": expected, "aspectRatio": round(aspect_ratio, 3), "controlledCondition": True})
            evidence["summary"] = f"Observed {orientation or 'no object'}; expected {expected} under a fixed camera view"
        elif kind == "object_size_check":
            minimum_area = max(0.0, float(definition.get("minAreaPercent", 1.0)))
            maximum_area = max(minimum_area, float(definition.get("maxAreaPercent", 25.0)))
            areas = []
            for item in in_zone:
                box = item.get("box") or [0, 0, 0, 0]
                area = max(0.0, float(box[2]) - float(box[0])) * max(0.0, float(box[3]) - float(box[1]))
                areas.append(area / max(1.0, width * height) * 100)
            best_area = areas[0] if areas else 0.0
            raw_active = bool(areas) and minimum_area <= best_area <= maximum_area
            value = round(best_area, 3)
            evidence.update({"areaPercent": round(best_area, 3), "minAreaPercent": minimum_area, "maxAreaPercent": maximum_area, "controlledCondition": True})
            evidence["summary"] = f"Object area {best_area:.2f}% compared with calibrated range {minimum_area:.2f}–{maximum_area:.2f}%"
        elif kind == "object_entered_roi":
            state_key = (camera_id, signal_id)
            confirmed_in_zone = [
                item for item in in_zone if bool(item.get("trackConfirmed", True))
            ]
            current_ids = {detection_key(item) for item in confirmed_in_zone} if zone else set()
            previous_ids = self._zone_membership.get(state_key)
            entered_ids = current_ids - previous_ids if previous_ids is not None else set()
            self._zone_membership[state_key] = current_ids
            if entered_ids:
                self._cumulative_counts[state_key] = self._cumulative_counts.get(state_key, 0) + len(entered_ids)
            cumulative_count = self._cumulative_counts.get(state_key, 0)
            raw_active = bool(entered_ids)
            value = cumulative_count
            evidence.update({
                "enteredTrackIds": sorted(entered_ids),
                "enteredThisFrame": len(entered_ids),
                "count": cumulative_count,
                "pendingTrackCount": len(in_zone) - len(confirmed_in_zone),
            })
            evidence["summary"] = (
                f"{cumulative_count} cumulative {class_name} entrance(s) into {zone.name}"
                if zone
                else "ROI is not configured"
            )
        elif kind == "pose_moving":
            threshold = max(0, float(definition.get("motionThreshold", 0.35)))
            scored = [
                (detection, motion_scores.get(detection_key(detection), 0.0))
                for detection in in_zone
                if detection.get("keypoints")
            ]
            best_detection, best_score = max(scored, key=lambda item: item[1], default=(None, 0.0))
            raw_active = best_detection is not None and best_score >= threshold
            value = round(best_score, 4)
            confidence = float(best_detection.get("confidence", 0)) if best_detection else 0.0
            evidence.update({
                "motionScore": round(best_score, 4),
                "motionThreshold": threshold,
                "trackId": str(best_detection.get("trackId")) if best_detection else None,
            })
            evidence["summary"] = f"Pose movement {best_score:.3f} compared with threshold {threshold:.3f}"
        else:
            evidence["summary"] = f"Unsupported signal kind: {kind}"

        hold_seconds = max(0.0, float(definition.get("holdSeconds", 0.0)))
        state_key = (camera_id, signal_id)
        if raw_active:
            self._signal_last_seen[state_key] = timestamp
        last_seen = self._signal_last_seen.get(state_key)
        held_active = bool(
            not raw_active
            and hold_seconds > 0
            and last_seen is not None
            and timestamp - last_seen <= hold_seconds
        )
        active = raw_active or held_active
        previous_active = self._previous_signal_active.get(state_key)
        state_changed = previous_active is not None and previous_active != active
        self._previous_signal_active[state_key] = active
        evidence["stateChanged"] = state_changed
        if state_changed:
            evidence["summary"] = f"{evidence.get('summary', name)} · state changed"

        return {
            "signalId": signal_id,
            "name": name,
            "kind": kind,
            "active": active,
            "rawActive": raw_active,
            "held": held_active,
            "stateChanged": state_changed,
            "value": value if isinstance(value, (int, float)) and not isinstance(value, bool) else active,
            "confidence": round(clamp(confidence, 0, 1), 4),
            "timestamp": timestamp,
            "evidence": evidence,
        }

    def _evaluate_rule(
        self,
        camera_id: str,
        timestamp: float,
        signals: dict[str, dict[str, Any]],
        rule: dict[str, Any],
    ) -> dict[str, Any]:
        rule_id = str(rule.get("id") or "rule")
        name = str(rule.get("name") or rule_id)
        output = str(rule.get("output") or name)
        combinator = str(rule.get("combinator") or "AND").upper()
        conditions = list(rule.get("conditions") or [])
        if rule.get("analysisEnabled", True) is False:
            self._rule_started_at.pop((camera_id, rule_id), None)
            self._sequence_progress.pop((camera_id, rule_id), None)
            self._sequence_started_at.pop((camera_id, rule_id), None)
            return {
                "ruleId": rule_id,
                "name": name,
                "output": output,
                "combinator": combinator,
                "matched": False,
                "active": False,
                "forSeconds": max(0.0, float(rule.get("forSeconds", 0.0))),
                "elapsedSeconds": 0.0,
                "withinSeconds": max(0.0, float(rule.get("withinSeconds", 0.0))) or None,
                "sequenceProgress": 0 if combinator == "SEQUENCE" else None,
                "conditions": [
                    {
                        "signalId": str(condition.get("signalId") or ""),
                        "operator": str(condition.get("operator") or "IS_ACTIVE").upper(),
                        "value": condition.get("value"),
                        "actual": False,
                        "actualValue": False,
                        "matched": False,
                    }
                    for condition in conditions
                ],
                "timestamp": timestamp,
            }
        evaluations = []
        for condition in conditions:
            signal_id = str(condition.get("signalId") or "")
            signal = signals.get(signal_id, {})
            actual = bool(signal.get("active", False))
            actual_value = signal.get("value", actual)
            operator = str(condition.get("operator") or (
                "IS_ACTIVE" if bool(condition.get("expected", True)) else "IS_NOT_ACTIVE"
            )).upper()
            target_value = float(condition.get("value", 0.0))
            if operator == "IS_NOT_ACTIVE":
                condition_matched = not actual
            elif operator == "GREATER_THAN":
                condition_matched = numeric_value(actual_value) > target_value
            elif operator == "LESS_THAN":
                condition_matched = numeric_value(actual_value) < target_value
            elif operator == "EQUALS":
                condition_matched = numeric_value(actual_value) == target_value
            elif operator == "STATE_CHANGE":
                condition_matched = bool(signal.get("stateChanged", False))
            else:
                operator = "IS_ACTIVE"
                condition_matched = actual
            evaluations.append({
                "signalId": signal_id,
                "operator": operator,
                "value": target_value if operator in {"GREATER_THAN", "LESS_THAN", "EQUALS"} else None,
                "actual": actual,
                "actualValue": actual_value,
                "matched": condition_matched,
            })

        state_key = (camera_id, rule_id)
        within_seconds = max(0.0, float(rule.get("withinSeconds", 0.0)))
        if combinator == "SEQUENCE":
            self._rule_started_at.pop(state_key, None)
            progress = self._sequence_progress.get(state_key, 0)
            sequence_started_at = self._sequence_started_at.get(state_key)
            if within_seconds and sequence_started_at is not None and timestamp - sequence_started_at > within_seconds:
                progress = 0
                sequence_started_at = None
            if not evaluations:
                progress = 0
            elif progress >= len(evaluations):
                progress = 0
                sequence_started_at = None
            elif evaluations[progress]["matched"]:
                if progress == 0:
                    sequence_started_at = timestamp
                progress += 1
            elif evaluations[0]["matched"]:
                progress = 1
                sequence_started_at = timestamp
            else:
                progress = 0
                sequence_started_at = None
            matched = bool(evaluations) and progress >= len(evaluations)
            self._sequence_progress[state_key] = progress
            if sequence_started_at is None:
                self._sequence_started_at.pop(state_key, None)
            else:
                self._sequence_started_at[state_key] = sequence_started_at
        else:
            self._sequence_progress.pop(state_key, None)
            self._sequence_started_at.pop(state_key, None)
            if not evaluations:
                matched = False
            elif combinator == "OR":
                matched = any(item["matched"] for item in evaluations)
            else:
                matched = all(item["matched"] for item in evaluations)

        if matched:
            self._rule_started_at.setdefault(state_key, timestamp)
        else:
            self._rule_started_at.pop(state_key, None)
        started_at = self._rule_started_at.get(state_key)
        elapsed_seconds = max(0.0, timestamp - started_at) if started_at is not None else 0.0
        for_seconds = max(0.0, float(rule.get("forSeconds", 0.0)))
        active = matched and elapsed_seconds >= for_seconds

        return {
            "ruleId": rule_id,
            "name": name,
            "output": output,
            "combinator": combinator,
            "matched": matched,
            "active": active,
            "forSeconds": for_seconds,
            "elapsedSeconds": round(elapsed_seconds, 2),
            "withinSeconds": within_seconds or None,
            "sequenceProgress": self._sequence_progress.get(state_key, 0) if combinator == "SEQUENCE" else None,
            "conditions": evaluations,
            "timestamp": timestamp,
        }

    def _calculate_motion_scores(
        self,
        camera_id: str,
        width: int,
        height: int,
        detections: list[dict[str, Any]],
    ) -> dict[str, float]:
        diagonal = max(1.0, hypot(width, height))
        scores: dict[str, float] = {}
        next_keypoints: dict[tuple[str, str], list[tuple[float, float, float]]] = {}

        for detection in detections:
            raw_keypoints = detection.get("keypoints") or []
            if not raw_keypoints:
                continue
            key = detection_key(detection)
            points = [
                (
                    float(point.get("x", 0)),
                    float(point.get("y", 0)),
                    float(point.get("confidence", 1)),
                )
                for point in raw_keypoints
            ]
            previous = self._previous_keypoints.get((camera_id, key))
            distances = []
            if previous:
                for current_point, previous_point in zip(points, previous):
                    if current_point[2] < 0.25 or previous_point[2] < 0.25:
                        continue
                    distances.append(hypot(current_point[0] - previous_point[0], current_point[1] - previous_point[1]))
            scores[key] = (sum(distances) / len(distances) / diagonal * 100) if distances else 0.0
            next_keypoints[(camera_id, key)] = points

        self._previous_keypoints.update(next_keypoints)
        return scores


def parse_zone(raw: dict[str, Any]) -> Zone:
    return Zone(
        id=str(raw.get("id") or "zone"),
        name=str(raw.get("name") or raw.get("id") or "Zone"),
        x=float(raw.get("x", 0)),
        y=float(raw.get("y", 0)),
        width=float(raw.get("width", 0)),
        height=float(raw.get("height", 0)),
        coordinate_space=str(raw.get("coordinateSpace") or "percent"),
    )


def detection_inside_zone(detection: dict[str, Any], zone: Zone, width: int, height: int) -> bool:
    zone_ids = detection.get("zoneIds")
    if isinstance(zone_ids, list):
        return zone.id in {str(zone_id) for zone_id in zone_ids}
    return box_center_inside(detection.get("box", [0, 0, 0, 0]), zone, width, height)


def box_center_inside(box: list[float], zone: Zone, width: int, height: int) -> bool:
    x1, y1, x2, y2 = (float(value) for value in box)
    center_x = (x1 + x2) / 2
    center_y = (y1 + y2) / 2
    if zone.coordinate_space == "percent":
        zone_x = zone.x / 100 * width
        zone_y = zone.y / 100 * height
        zone_width = zone.width / 100 * width
        zone_height = zone.height / 100 * height
    else:
        zone_x, zone_y, zone_width, zone_height = zone.x, zone.y, zone.width, zone.height
    return zone_x <= center_x <= zone_x + zone_width and zone_y <= center_y <= zone_y + zone_height


def detection_key(detection: dict[str, Any]) -> str:
    return f"{detection.get('modelId', 'model')}:{detection.get('trackId', detection.get('id', 'unknown'))}"


def box_center(box: list[float]) -> tuple[float, float]:
    x1, y1, x2, y2 = (float(value) for value in box)
    return (x1 + x2) / 2, (y1 + y2) / 2


def numeric_value(value: Any) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_hex_color(value: str) -> tuple[int, int, int]:
    normalized = value.strip().lstrip("#")
    if len(normalized) == 3:
        normalized = "".join(character * 2 for character in normalized)
    try:
        if len(normalized) != 6:
            raise ValueError
        return int(normalized[0:2], 16), int(normalized[2:4], 16), int(normalized[4:6], 16)
    except ValueError:
        return 34, 197, 94


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))
