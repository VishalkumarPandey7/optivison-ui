from __future__ import annotations

import base64
from collections import deque
from dataclasses import dataclass
from math import hypot
from typing import Any

import cv2
import numpy as np
import supervision as sv


def zone_bounds(zone: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    if str(zone.get("coordinateSpace") or "percent") == "percent":
        x = round(float(zone.get("x", 0)) / 100 * width)
        y = round(float(zone.get("y", 0)) / 100 * height)
        zone_width = round(float(zone.get("width", 0)) / 100 * width)
        zone_height = round(float(zone.get("height", 0)) / 100 * height)
    else:
        x = round(float(zone.get("x", 0)))
        y = round(float(zone.get("y", 0)))
        zone_width = round(float(zone.get("width", 0)))
        zone_height = round(float(zone.get("height", 0)))
    x = max(0, min(width, x))
    y = max(0, min(height, y))
    return x, y, max(0, min(width - x, zone_width)), max(0, min(height - y, zone_height))


def line_points(line: dict[str, Any], width: int, height: int) -> tuple[tuple[int, int], tuple[int, int]]:
    start = dict(line.get("start") or {})
    end = dict(line.get("end") or {})
    if str(line.get("coordinateSpace") or "percent") == "percent":
        return (
            (round(float(start.get("x", 0)) / 100 * width), round(float(start.get("y", 0)) / 100 * height)),
            (round(float(end.get("x", 0)) / 100 * width), round(float(end.get("y", 0)) / 100 * height)),
        )
    return (
        (round(float(start.get("x", 0))), round(float(start.get("y", 0)))),
        (round(float(end.get("x", 0))), round(float(end.get("y", 0)))),
    )


def line_is_drawn(line: dict[str, Any], width: int, height: int) -> bool:
    start, end = line_points(line, width, height)
    return hypot(end[0] - start[0], end[1] - start[1]) >= 3


def line_is_inside_zone(line: dict[str, Any], zone: dict[str, Any], width: int, height: int) -> bool:
    start, end = line_points(line, width, height)
    x, y, zone_width, zone_height = zone_bounds(zone, width, height)
    return all(
        x <= point[0] <= x + zone_width and y <= point[1] <= y + zone_height
        for point in (start, end)
    )


@dataclass
class TrackHistory:
    first_center: tuple[float, float]
    current_center: tuple[float, float]
    seen_frames: int = 1
    last_seen_frame: int = 0


@dataclass
class PendingCrossing:
    direction: str
    timestamp: float
    box: list[float]
    source: str


class StableLineCounter:
    """Debounced LineZone wrapper that counts every stable track at most once."""

    def __init__(
        self,
        start: tuple[int, int],
        end: tuple[int, int],
        *,
        minimum_seen_frames: int = 3,
        minimum_movement: float = 4.0,
    ) -> None:
        self.line_zone = sv.LineZone(
            start=sv.Point(*start),
            end=sv.Point(*end),
            triggering_anchors=[sv.Position.CENTER],
            minimum_crossing_threshold=2,
        )
        self.minimum_seen_frames = max(2, minimum_seen_frames)
        self.minimum_movement = max(1.0, minimum_movement)
        self.frame_index = 0
        self.inbound_count = 0
        self.outbound_count = 0
        self.counted_track_ids: set[int] = set()
        self.track_history: dict[int, TrackHistory] = {}
        self.pending_crossings: dict[int, PendingCrossing] = {}
        self.crossing_history: deque[dict[str, Any]] = deque(maxlen=100)
        self.last_direction: str | None = None

    def process(self, tracked: sv.Detections, timestamp: float) -> dict[str, Any]:
        self.frame_index += 1
        tracker_ids = tracked.tracker_id if tracked.tracker_id is not None else np.array([], dtype=int)
        sources = tracked.data.get("source", np.array(["object-proposal"] * len(tracked), dtype=object))

        for index, raw_track_id in enumerate(tracker_ids):
            track_id = int(raw_track_id)
            x1, y1, x2, y2 = (float(value) for value in tracked.xyxy[index])
            center = ((x1 + x2) / 2, (y1 + y2) / 2)
            history = self.track_history.get(track_id)
            if history is None:
                self.track_history[track_id] = TrackHistory(center, center, last_seen_frame=self.frame_index)
            else:
                history.current_center = center
                history.seen_frames += 1
                history.last_seen_frame = self.frame_index

        crossed_in, crossed_out = self.line_zone.trigger(tracked)
        crossed_this_frame: list[dict[str, Any]] = []
        for index, raw_track_id in enumerate(tracker_ids):
            if not crossed_in[index] and not crossed_out[index]:
                continue
            track_id = int(raw_track_id)
            if track_id in self.counted_track_ids:
                continue
            direction = "inbound" if bool(crossed_in[index]) else "outbound"
            self.pending_crossings.setdefault(
                track_id,
                PendingCrossing(
                    direction=direction,
                    timestamp=timestamp,
                    box=[round(float(value), 2) for value in tracked.xyxy[index]],
                    source=str(sources[index]),
                ),
            )

        # LineZone reports a crossing only on the transition frame. Keep that
        # transition pending until ByteTrack has supplied enough observations to
        # confirm it is a real moving object instead of dropping the pass.
        for raw_track_id in tracker_ids:
            track_id = int(raw_track_id)
            pending = self.pending_crossings.get(track_id)
            if pending is None or track_id in self.counted_track_ids:
                continue
            history = self.track_history[track_id]
            displacement = hypot(
                history.current_center[0] - history.first_center[0],
                history.current_center[1] - history.first_center[1],
            )
            stable = history.seen_frames >= self.minimum_seen_frames and displacement >= self.minimum_movement
            if not stable:
                continue

            direction = pending.direction
            if direction == "inbound":
                self.inbound_count += 1
            else:
                self.outbound_count += 1
            self.counted_track_ids.add(track_id)
            self.pending_crossings.pop(track_id, None)
            self.last_direction = direction
            pass_number = self.inbound_count + self.outbound_count
            event = {
                "id": f"pass-{pass_number}-{direction}-{track_id}-{pending.timestamp:.6f}",
                "timestamp": pending.timestamp,
                "direction": direction,
                "trackId": track_id,
                "passNumber": pass_number,
                "box": pending.box,
                "source": pending.source,
            }
            self.crossing_history.appendleft(event)
            crossed_this_frame.append(event)

        self.track_history = {
            track_id: history
            for track_id, history in self.track_history.items()
            if self.frame_index - history.last_seen_frame <= 60
        }
        self.pending_crossings = {
            track_id: pending
            for track_id, pending in self.pending_crossings.items()
            if track_id in self.track_history
        }

        live_tracks = []
        for index, raw_track_id in enumerate(tracker_ids):
            track_id = int(raw_track_id)
            history = self.track_history[track_id]
            displacement = hypot(
                history.current_center[0] - history.first_center[0],
                history.current_center[1] - history.first_center[1],
            )
            live_tracks.append({
                "trackId": track_id,
                "box": [round(float(value), 2) for value in tracked.xyxy[index]],
                "center": [round(value, 2) for value in history.current_center],
                "source": str(sources[index]),
                "stable": history.seen_frames >= self.minimum_seen_frames and displacement >= self.minimum_movement,
                "seenFrames": history.seen_frames,
                "displacement": round(displacement, 2),
                "counted": track_id in self.counted_track_ids,
            })

        return {
            "inboundCount": self.inbound_count,
            "outboundCount": self.outbound_count,
            "totalCount": self.inbound_count + self.outbound_count,
            "lastDirection": self.last_direction,
            "crossedThisFrame": len(crossed_this_frame),
            "crossingEvents": crossed_this_frame,
            "crossings": list(self.crossing_history),
            "liveTracks": live_tracks,
            "ratePerMinute": sum(1 for event in self.crossing_history if timestamp - float(event["timestamp"]) <= 60.0),
            "spatialEngine": "supervision-line-zone",
            "trackingEngine": "supervision-bytetrack",
        }


class StableMotionPassCounter:
    """Counts each stable foreground track once without requiring a line crossing."""

    def __init__(
        self,
        *,
        direction_start: tuple[int, int] | None = None,
        direction_end: tuple[int, int] | None = None,
        minimum_seen_frames: int = 2,
        minimum_movement: float = 2.0,
    ) -> None:
        self.direction_start = direction_start
        self.direction_end = direction_end
        self.minimum_seen_frames = max(2, minimum_seen_frames)
        self.minimum_movement = max(1.0, minimum_movement)
        self.frame_index = 0
        self.inbound_count = 0
        self.outbound_count = 0
        self.counted_track_ids: set[int] = set()
        self.track_history: dict[int, TrackHistory] = {}
        self.crossing_history: deque[dict[str, Any]] = deque(maxlen=100)
        self.last_direction: str | None = None

    def process(self, tracked: sv.Detections, timestamp: float) -> dict[str, Any]:
        self.frame_index += 1
        tracker_ids = tracked.tracker_id if tracked.tracker_id is not None else np.array([], dtype=int)
        sources = tracked.data.get("source", np.array(["direct-motion"] * len(tracked), dtype=object))
        crossed_this_frame: list[dict[str, Any]] = []

        for index, raw_track_id in enumerate(tracker_ids):
            track_id = int(raw_track_id)
            x1, y1, x2, y2 = (float(value) for value in tracked.xyxy[index])
            center = ((x1 + x2) / 2, (y1 + y2) / 2)
            history = self.track_history.get(track_id)
            if history is None:
                history = TrackHistory(center, center, last_seen_frame=self.frame_index)
                self.track_history[track_id] = history
            else:
                history.current_center = center
                history.seen_frames += 1
                history.last_seen_frame = self.frame_index

            displacement = hypot(
                history.current_center[0] - history.first_center[0],
                history.current_center[1] - history.first_center[1],
            )
            stable = history.seen_frames >= self.minimum_seen_frames and displacement >= self.minimum_movement
            if not stable or track_id in self.counted_track_ids:
                continue

            direction = self._direction(history)
            if direction == "inbound":
                self.inbound_count += 1
            else:
                self.outbound_count += 1
            self.counted_track_ids.add(track_id)
            self.last_direction = direction
            pass_number = self.inbound_count + self.outbound_count
            event = {
                "id": f"motion-pass-{pass_number}-{track_id}-{timestamp:.6f}",
                "timestamp": timestamp,
                "direction": direction,
                "trackId": track_id,
                "passNumber": pass_number,
                "box": [round(float(value), 2) for value in tracked.xyxy[index]],
                "source": str(sources[index]),
            }
            self.crossing_history.appendleft(event)
            crossed_this_frame.append(event)

        self.track_history = {
            track_id: history
            for track_id, history in self.track_history.items()
            if self.frame_index - history.last_seen_frame <= 60
        }

        live_tracks = []
        for index, raw_track_id in enumerate(tracker_ids):
            track_id = int(raw_track_id)
            history = self.track_history[track_id]
            displacement = hypot(
                history.current_center[0] - history.first_center[0],
                history.current_center[1] - history.first_center[1],
            )
            live_tracks.append({
                "trackId": track_id,
                "box": [round(float(value), 2) for value in tracked.xyxy[index]],
                "center": [round(value, 2) for value in history.current_center],
                "source": str(sources[index]),
                "stable": history.seen_frames >= self.minimum_seen_frames and displacement >= self.minimum_movement,
                "seenFrames": history.seen_frames,
                "displacement": round(displacement, 2),
                "counted": track_id in self.counted_track_ids,
            })

        return {
            "inboundCount": self.inbound_count,
            "outboundCount": self.outbound_count,
            "totalCount": self.inbound_count + self.outbound_count,
            "lastDirection": self.last_direction,
            "crossedThisFrame": len(crossed_this_frame),
            "crossingEvents": crossed_this_frame,
            "crossings": list(self.crossing_history),
            "liveTracks": live_tracks,
            "ratePerMinute": sum(1 for event in self.crossing_history if timestamp - float(event["timestamp"]) <= 60.0),
            "countingMode": "direct-motion-zone",
            "spatialEngine": "background-subtraction-motion-zone",
            "trackingEngine": "direct-centroid-motion-tracker",
        }

    def _direction(self, history: TrackHistory) -> str:
        movement_x = history.current_center[0] - history.first_center[0]
        movement_y = history.current_center[1] - history.first_center[1]
        if self.direction_start is not None and self.direction_end is not None:
            line_x = self.direction_end[0] - self.direction_start[0]
            line_y = self.direction_end[1] - self.direction_start[1]
            projection = movement_x * -line_y + movement_y * line_x
        else:
            projection = movement_x if abs(movement_x) >= abs(movement_y) else movement_y
        return "inbound" if projection >= 0 else "outbound"


@dataclass
class MotionAnalysis:
    proposals: list[dict[str, Any]]
    mask_data_url: str | None
    foreground_percent: float


@dataclass
class DirectMotionTrack:
    box: np.ndarray
    center: tuple[float, float]
    last_seen_frame: int


class DirectMotionTracker:
    """Associates foreground blobs across short gaps using centroid distance."""

    def __init__(self, *, max_missed_frames: int = 6) -> None:
        self.max_missed_frames = max(1, max_missed_frames)
        self.frame_index = 0
        self.next_track_id = 1
        self.tracks: dict[int, DirectMotionTrack] = {}

    def update_with_detections(self, detections: sv.Detections) -> sv.Detections:
        self.frame_index += 1
        self.tracks = {
            track_id: track
            for track_id, track in self.tracks.items()
            if self.frame_index - track.last_seen_frame <= self.max_missed_frames
        }
        if len(detections) == 0:
            empty = sv.Detections.empty()
            empty.data["source"] = np.array([], dtype=object)
            return empty

        boxes = np.asarray(detections.xyxy, dtype=np.float32)
        centers = [
            ((float(box[0]) + float(box[2])) / 2, (float(box[1]) + float(box[3])) / 2)
            for box in boxes
        ]
        candidates: list[tuple[float, int, int]] = []
        for track_id, track in self.tracks.items():
            track_width = max(1.0, float(track.box[2] - track.box[0]))
            track_height = max(1.0, float(track.box[3] - track.box[1]))
            for detection_index, (box, center) in enumerate(zip(boxes, centers)):
                box_width = max(1.0, float(box[2] - box[0]))
                box_height = max(1.0, float(box[3] - box[1]))
                distance = hypot(center[0] - track.center[0], center[1] - track.center[1])
                maximum_distance = max(
                    24.0,
                    hypot(max(track_width, box_width), max(track_height, box_height)) * 1.6,
                )
                if distance <= maximum_distance:
                    candidates.append((distance, track_id, detection_index))

        assigned_tracks: set[int] = set()
        assigned_detections: set[int] = set()
        detection_track_ids: dict[int, int] = {}
        for _, track_id, detection_index in sorted(candidates):
            if track_id in assigned_tracks or detection_index in assigned_detections:
                continue
            assigned_tracks.add(track_id)
            assigned_detections.add(detection_index)
            detection_track_ids[detection_index] = track_id

        for detection_index in range(len(boxes)):
            track_id = detection_track_ids.get(detection_index)
            if track_id is None:
                track_id = self.next_track_id
                self.next_track_id += 1
                detection_track_ids[detection_index] = track_id
            self.tracks[track_id] = DirectMotionTrack(
                box=boxes[detection_index].copy(),
                center=centers[detection_index],
                last_seen_frame=self.frame_index,
            )

        return sv.Detections(
            xyxy=boxes,
            confidence=(detections.confidence.copy() if detections.confidence is not None else None),
            class_id=(detections.class_id.copy() if detections.class_id is not None else None),
            tracker_id=np.asarray([detection_track_ids[index] for index in range(len(boxes))], dtype=int),
            data={key: np.asarray(value).copy() for key, value in detections.data.items()},
        )


class MotionProposalGenerator:
    """Creates a direct grey/white foreground mask and generic ROI proposals."""

    def __init__(self, pixel_delta_threshold: int = 18) -> None:
        self.pixel_delta_threshold = pixel_delta_threshold
        self.previous_frames: dict[tuple[str, str], np.ndarray] = {}
        self.background_subtractors: dict[tuple[str, str], Any] = {}

    def reset(self, camera_id: str | None = None) -> None:
        if camera_id is None:
            self.previous_frames.clear()
            self.background_subtractors.clear()
        else:
            self.previous_frames = {
                key: frame for key, frame in self.previous_frames.items() if key[0] != camera_id
            }
            self.background_subtractors = {
                key: subtractor for key, subtractor in self.background_subtractors.items() if key[0] != camera_id
            }

    def analyze(self, camera_id: str, image: np.ndarray, zone: dict[str, Any]) -> list[dict[str, Any]]:
        return self.analyze_with_mask(camera_id, image, zone).proposals

    def analyze_with_mask(self, camera_id: str, image: np.ndarray, zone: dict[str, Any]) -> MotionAnalysis:
        height, width = image.shape[:2]
        x, y, roi_width, roi_height = zone_bounds(zone, width, height)
        if roi_width < 4 or roi_height < 4:
            return MotionAnalysis([], None, 0.0)

        roi = image[y:y + roi_height, x:x + roi_width]
        gray = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        key = (camera_id, str(zone.get("id") or "counting-zone"))
        previous = self.previous_frames.get(key)
        self.previous_frames[key] = gray.copy()
        subtractor = self.background_subtractors.get(key)
        if subtractor is None or previous is None or previous.shape != gray.shape:
            subtractor = cv2.createBackgroundSubtractorMOG2(
                history=120,
                varThreshold=24,
                detectShadows=False,
            )
            self.background_subtractors[key] = subtractor
            subtractor.apply(gray, learningRate=1.0)
            mask = np.zeros_like(gray)
        else:
            background_mask = subtractor.apply(gray, learningRate=0.015)
            difference = cv2.absdiff(previous, gray)
            _, difference_mask = cv2.threshold(
                difference,
                self.pixel_delta_threshold,
                255,
                cv2.THRESH_BINARY,
            )
            mask = cv2.bitwise_or(background_mask, difference_mask)

        kernel = np.ones((5, 5), dtype=np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.dilate(mask, kernel, iterations=2)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        roi_area = float(roi_width * roi_height)
        minimum_area = max(80.0, roi_area * 0.0025)
        maximum_area = roi_area * 0.80
        proposals = []
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if area < minimum_area or area > maximum_area:
                continue
            bx, by, box_width, box_height = cv2.boundingRect(contour)
            if box_width < 4 or box_height < 4:
                continue
            proposals.append({
                "box": [float(x + bx), float(y + by), float(x + bx + box_width), float(y + by + box_height)],
                "confidence": 0.65,
                "source": "motion-fallback",
            })
        foreground_percent = round(float(np.count_nonzero(mask)) / max(1.0, roi_area) * 100, 3)
        display_mask = np.full(mask.shape, 72, dtype=np.uint8)
        display_mask[mask > 0] = 255
        encoded, png = cv2.imencode(".png", display_mask)
        mask_data_url = (
            f"data:image/png;base64,{base64.b64encode(png.tobytes()).decode('ascii')}"
            if encoded
            else None
        )
        return MotionAnalysis(
            class_independent_nms(proposals, 0.35),
            mask_data_url,
            foreground_percent,
        )


@dataclass
class ConveyorState:
    signature: tuple[Any, ...]
    tracker: Any
    counter: StableLineCounter | StableMotionPassCounter


class ConveyorCountingRuntime:
    """Per-camera direct foreground-motion and stable pass counting runtime."""

    def __init__(self) -> None:
        self.states: dict[tuple[str, str], ConveyorState] = {}
        self.motion = MotionProposalGenerator()

    def reset(self, camera_id: str | None = None) -> None:
        if camera_id is None:
            self.states.clear()
        else:
            self.states = {key: state for key, state in self.states.items() if key[0] != camera_id}
        self.motion.reset(camera_id)

    def analyze(
        self,
        *,
        camera_id: str,
        timestamp: float,
        image: np.ndarray,
        detections: list[dict[str, Any]],
        zones: list[dict[str, Any]],
        counting_lines: list[dict[str, Any]],
        signal_definitions: list[dict[str, Any]],
    ) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
        height, width = image.shape[:2]
        zones_by_id = {str(zone.get("id") or ""): zone for zone in zones}
        lines_by_id = {str(line.get("id") or ""): line for line in counting_lines}
        metrics: dict[str, dict[str, Any]] = {}
        generic_detections: list[dict[str, Any]] = []
        processed_zones: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}
        motion_by_zone: dict[str, MotionAnalysis] = {}

        for definition in signal_definitions:
            if str(definition.get("kind") or "") not in {"line_crossing_count", "line_crossing_rate"}:
                continue
            signal_id = str(definition.get("id") or "conveyor-line-crossing")
            zone_id = str(definition.get("zoneId") or "")
            line_id = str(definition.get("lineId") or "")
            zone = zones_by_id.get(zone_id)
            line = lines_by_id.get(line_id)
            line_ready = bool(
                line
                and str(line.get("zoneId") or "") == zone_id
                and line_is_drawn(line, width, height)
                and line_is_inside_zone(line, zone, width, height)
            ) if zone else False
            configured = bool(
                definition.get("analysisEnabled", True)
                and zone
                and zone_bounds(zone, width, height)[2] >= 4
                and zone_bounds(zone, width, height)[3] >= 4
            )
            if not configured:
                metrics[signal_id] = empty_counting_metric(line_id, zone_id)
                continue

            if zone_id not in processed_zones:
                if zone_id not in motion_by_zone:
                    motion_by_zone[zone_id] = self.motion.analyze_with_mask(camera_id, image, zone)
                motion_analysis = motion_by_zone[zone_id]
                state = self._state(camera_id, zone_id, line if line_ready else None, zone, width, height)
                tracked = state.tracker.update_with_detections(proposals_to_detections(motion_analysis.proposals))
                snapshot = state.counter.process(tracked, timestamp)
                snapshot.update({
                    "configured": True,
                    "lineId": line_id if line_ready else None,
                    "zoneId": zone_id,
                    "motionMask": motion_analysis.mask_data_url,
                    "foregroundPercent": motion_analysis.foreground_percent,
                    "countingMode": "supervision-line-zone" if line_ready else "direct-motion-zone",
                })
                motion_tracks = tracked_to_generic_detections(tracked, camera_id, zone_id, zone_id)
                processed_zones[zone_id] = (snapshot, motion_tracks)
                generic_detections.extend(motion_tracks)
            metrics[signal_id] = processed_zones[zone_id][0]

        return metrics, deduplicate_public_detections(generic_detections)

    def _state(
        self,
        camera_id: str,
        zone_id: str,
        line: dict[str, Any] | None,
        zone: dict[str, Any],
        width: int,
        height: int,
    ) -> ConveyorState:
        start, end = line_points(line, width, height) if line else (None, None)
        signature = (width, height, start, end, zone_bounds(zone, width, height))
        key = (camera_id, zone_id)
        state = self.states.get(key)
        if state is None or state.signature != signature:
            roi_x, roi_y, roi_width, roi_height = signature[-1]
            minimum_movement = max(2.0, hypot(roi_width, roi_height) * 0.006)
            state = ConveyorState(
                signature=signature,
                tracker=(
                    sv.ByteTrack(
                        track_activation_threshold=0.15,
                        minimum_consecutive_frames=1,
                        lost_track_buffer=18,
                        frame_rate=10.0,
                    )
                    if start is not None and end is not None
                    else DirectMotionTracker(max_missed_frames=6)
                ),
                counter=(
                    StableLineCounter(start, end, minimum_seen_frames=2, minimum_movement=minimum_movement)
                    if start is not None and end is not None
                    else StableMotionPassCounter(minimum_seen_frames=2, minimum_movement=minimum_movement)
                ),
            )
            self.states[key] = state
        return state


def empty_counting_metric(line_id: str, zone_id: str) -> dict[str, Any]:
    return {
        "configured": False,
        "lineId": line_id or None,
        "zoneId": zone_id or None,
        "inboundCount": 0,
        "outboundCount": 0,
        "totalCount": 0,
        "lastDirection": None,
        "crossedThisFrame": 0,
        "crossingEvents": [],
        "crossings": [],
        "liveTracks": [],
        "ratePerMinute": 0.0,
        "motionMask": None,
        "foregroundPercent": 0.0,
        "countingMode": "direct-motion-zone",
        "spatialEngine": "background-subtraction-motion-zone",
        "trackingEngine": "direct-centroid-motion-tracker",
    }


def detector_proposals(detections: list[dict[str, Any]], zone_id: str) -> list[dict[str, Any]]:
    proposals = []
    for detection in detections:
        if zone_id not in [str(value) for value in detection.get("zoneIds") or []]:
            continue
        if str(detection.get("task") or "detect") != "detect":
            continue
        box = detection.get("box") or []
        if len(box) != 4:
            continue
        proposals.append({
            "box": [float(value) for value in box],
            "confidence": max(0.2, float(detection.get("confidence", 0.5))),
            "source": f"yolo:{detection.get('modelId') or 'detector'}",
        })
    return proposals


def proposals_to_detections(proposals: list[dict[str, Any]]) -> sv.Detections:
    if not proposals:
        detections = sv.Detections.empty()
        detections.data["source"] = np.array([], dtype=object)
        return detections
    return sv.Detections(
        xyxy=np.asarray([proposal["box"] for proposal in proposals], dtype=np.float32),
        confidence=np.asarray([proposal["confidence"] for proposal in proposals], dtype=np.float32),
        class_id=np.zeros(len(proposals), dtype=int),
        data={"source": np.asarray([proposal["source"] for proposal in proposals], dtype=object)},
    )


def tracked_to_generic_detections(
    tracked: sv.Detections,
    camera_id: str,
    line_id: str,
    zone_id: str,
) -> list[dict[str, Any]]:
    tracker_ids = tracked.tracker_id if tracked.tracker_id is not None else np.array([], dtype=int)
    sources = tracked.data.get("source", np.array([""] * len(tracked), dtype=object))
    confidences = tracked.confidence if tracked.confidence is not None else np.full(len(tracked), 0.5)
    result = []
    for index, raw_track_id in enumerate(tracker_ids):
        source = str(sources[index])
        if source != "motion-fallback":
            continue
        track_id = int(raw_track_id)
        result.append({
            "id": f"{camera_id}-{line_id}-motion-{track_id}",
            "trackId": track_id,
            "trackConfirmed": True,
            "className": "object",
            "confidence": round(float(confidences[index]), 4),
            "box": [round(float(value), 2) for value in tracked.xyxy[index]],
            "modelId": "motion-fallback",
            "task": "detect",
            "keypoints": [],
            "zoneIds": [zone_id],
            "spatialEngine": "grey-white-motion-mask+direct-centroid-tracker",
        })
    return result


def class_independent_nms(proposals: list[dict[str, Any]], threshold: float) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for proposal in sorted(proposals, key=lambda item: float(item.get("confidence", 0)), reverse=True):
        if any(box_overlap_ratio(proposal["box"], current["box"]) >= threshold for current in kept):
            continue
        kept.append(proposal)
    return kept


def deduplicate_public_detections(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    seen = set()
    for detection in detections:
        key = str(detection.get("id"))
        if key in seen:
            continue
        seen.add(key)
        result.append(detection)
    return result


def box_overlap_ratio(first: list[float], second: list[float]) -> float:
    ax1, ay1, ax2, ay2 = (float(value) for value in first)
    bx1, by1, bx2, by2 = (float(value) for value in second)
    intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(0.0, min(ay2, by2) - max(ay1, by1))
    smaller_area = min(max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1), max(0.0, bx2 - bx1) * max(0.0, by2 - by1))
    return intersection / smaller_area if smaller_area > 0 else 0.0
