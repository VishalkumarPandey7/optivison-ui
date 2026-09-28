import unittest

from engine import SignalRuleEngine


class SignalRuleEngineTest(unittest.TestCase):
    def setUp(self):
        self.engine = SignalRuleEngine()
        self.zone = {
            "id": "work-zone",
            "name": "Work Zone",
            "x": 20,
            "y": 20,
            "width": 60,
            "height": 60,
            "coordinateSpace": "percent",
        }

    def evaluate(self, timestamp, detections, signals, rules=None, zone_metrics=None, camera_id="cam-1"):
        return self.engine.evaluate(
            camera_id=camera_id,
            timestamp=timestamp,
            width=100,
            height=100,
            detections=detections,
            zones=[self.zone],
            signal_definitions=signals,
            rules=rules or [],
            zone_metrics=zone_metrics,
        )

    def test_object_detection_and_roi_become_reusable_signals(self):
        detections = [{
            "trackId": 7,
            "className": "person",
            "confidence": 0.91,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n",
            "task": "detect",
        }]
        result = self.evaluate(1.0, detections, [
            {"id": "person-seen", "kind": "object_detected", "className": "person", "sourceTask": "detect"},
            {"id": "person-in-work-zone", "kind": "object_in_roi", "className": "person", "zoneId": "work-zone", "sourceTask": "detect"},
        ])

        self.assertTrue(result["signals"][0]["active"])
        self.assertTrue(result["signals"][1]["active"])
        self.assertEqual(result["signals"][1]["evidence"]["trackIds"], ["7"])

    def test_pose_keypoint_delta_creates_body_moving_signal(self):
        definition = [{
            "id": "body-moving",
            "kind": "pose_moving",
            "className": "person",
            "zoneId": "work-zone",
            "sourceTask": "pose",
            "motionThreshold": 1.0,
        }]
        first = [{
            "trackId": 3,
            "className": "person",
            "confidence": 0.9,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n_pose",
            "task": "pose",
            "keypoints": [{"x": 35, "y": 35, "confidence": 0.9}, {"x": 40, "y": 50, "confidence": 0.9}],
        }]
        second = [{**first[0], "keypoints": [{"x": 39, "y": 39, "confidence": 0.9}, {"x": 44, "y": 54, "confidence": 0.9}]}]

        self.assertFalse(self.evaluate(1.0, first, definition)["signals"][0]["active"])
        moving = self.evaluate(1.5, second, definition)["signals"][0]
        self.assertTrue(moving["active"])
        self.assertGreater(moving["evidence"]["motionScore"], 1.0)

    def test_rule_combines_signals_and_waits_for_duration(self):
        signals = [
            {"id": "person-in-zone", "kind": "object_in_roi", "className": "person", "zoneId": "work-zone"},
            {"id": "no-phone", "kind": "object_detected", "className": "cell phone"},
        ]
        rules = [{
            "id": "worker-ready",
            "name": "Worker Ready",
            "output": "WORKER_READY",
            "combinator": "AND",
            "forSeconds": 2,
            "conditions": [
                {"signalId": "person-in-zone", "expected": True},
                {"signalId": "no-phone", "expected": False},
            ],
        }]
        detections = [{
            "trackId": 1,
            "className": "person",
            "confidence": 0.9,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n",
            "task": "detect",
        }]

        waiting = self.evaluate(10.0, detections, signals, rules)["rules"][0]
        active = self.evaluate(12.1, detections, signals, rules)["rules"][0]
        self.assertTrue(waiting["matched"])
        self.assertFalse(waiting["active"])
        self.assertTrue(active["active"])

    def test_state_change_operator_fires_when_a_signal_changes(self):
        signal = [{"id": "person-seen", "kind": "object_detected", "className": "person"}]
        rule = [{
            "id": "person-left",
            "name": "Person Left",
            "output": "PERSON_LEFT",
            "combinator": "AND",
            "forSeconds": 0,
            "conditions": [{"signalId": "person-seen", "operator": "STATE_CHANGE"}],
        }]
        person = [{
            "trackId": 1,
            "className": "person",
            "confidence": 0.9,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n",
            "task": "detect",
        }]

        self.assertFalse(self.evaluate(1.0, person, signal, rule)["rules"][0]["active"])
        changed = self.evaluate(2.0, [], signal, rule)["rules"][0]
        self.assertTrue(changed["conditions"][0]["matched"])
        self.assertTrue(changed["active"])

    def test_sequence_rule_requires_conditions_in_order_within_window(self):
        signals = [
            {"id": "person-seen", "kind": "object_detected", "className": "person"},
            {"id": "phone-seen", "kind": "object_detected", "className": "cell phone"},
        ]
        rule = [{
            "id": "sequence-rule",
            "name": "Person Then Phone",
            "output": "PERSON_THEN_PHONE",
            "combinator": "SEQUENCE",
            "forSeconds": 0,
            "withinSeconds": 3,
            "conditions": [
                {"signalId": "person-seen", "operator": "IS_ACTIVE"},
                {"signalId": "phone-seen", "operator": "IS_ACTIVE"},
            ],
        }]
        person = [{
            "trackId": 1,
            "className": "person",
            "confidence": 0.9,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n",
            "task": "detect",
        }]
        phone = [{
            "trackId": 2,
            "className": "cell phone",
            "confidence": 0.9,
            "box": [35, 35, 45, 45],
            "modelId": "yolo11n",
            "task": "detect",
        }]

        first = self.evaluate(1.0, person, signals, rule)["rules"][0]
        self.assertFalse(first["matched"])
        second = self.evaluate(2.0, phone, signals, rule)["rules"][0]
        self.assertTrue(second["matched"])
        self.assertTrue(second["active"])
        expired = self.evaluate(6.0, phone, signals, rule)["rules"][0]
        self.assertFalse(expired["matched"])

    def test_rule_timers_are_isolated_between_cameras(self):
        signals = [{"id": "person-seen", "kind": "object_detected", "className": "person"}]
        rules = [{
            "id": "person-held",
            "name": "Person Held",
            "output": "PERSON_HELD",
            "forSeconds": 2,
            "conditions": [{"signalId": "person-seen", "expected": True}],
        }]
        person = [{
            "trackId": 1,
            "className": "person",
            "confidence": 0.9,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n",
            "task": "detect",
        }]

        self.evaluate(10.0, person, signals, rules, camera_id="cam-1")
        camera_one = self.evaluate(12.1, person, signals, rules, camera_id="cam-1")["rules"][0]
        camera_two = self.evaluate(12.1, person, signals, rules, camera_id="cam-2")["rules"][0]

        self.assertTrue(camera_one["active"])
        self.assertTrue(camera_two["matched"])
        self.assertFalse(camera_two["active"])
        self.assertEqual(camera_two["elapsedSeconds"], 0.0)

    def test_operator_absence_is_a_first_class_roi_signal(self):
        signal = [{
            "id": "operator-absent",
            "kind": "object_absent_from_roi",
            "className": "person",
            "zoneId": "work-zone",
        }]
        person = [{
            "trackId": 1,
            "className": "person",
            "confidence": 0.9,
            "box": [30, 30, 60, 80],
            "modelId": "yolo11n",
            "task": "detect",
        }]

        self.assertFalse(self.evaluate(1.0, person, signal)["signals"][0]["active"])
        absent = self.evaluate(2.0, [], signal)["signals"][0]
        self.assertTrue(absent["active"])
        self.assertEqual(absent["evidence"]["inZoneCount"], 0)

    def test_person_and_phone_proximity_can_drive_restricted_zone_rule(self):
        detections = [
            {
                "trackId": 1,
                "className": "person",
                "confidence": 0.9,
                "box": [30, 30, 60, 80],
                "modelId": "yolo11n",
                "task": "detect",
            },
            {
                "trackId": 2,
                "className": "cell phone",
                "confidence": 0.8,
                "box": [52, 48, 58, 58],
                "modelId": "yolo11n",
                "task": "detect",
            },
        ]
        signal = [{
            "id": "mobile-use",
            "kind": "objects_near",
            "className": "person",
            "secondaryClass": "cell phone",
            "zoneId": "work-zone",
            "maxDistancePercent": 25,
        }]

        state = self.evaluate(1.0, detections, signal)["signals"][0]
        self.assertTrue(state["active"])
        self.assertEqual(len(state["evidence"]["pairs"]), 1)

    def test_roi_motion_and_idle_are_detector_independent_signals(self):
        signals = [
            {"id": "machine-moving", "kind": "zone_motion", "zoneId": "work-zone", "motionThreshold": 2},
            {"id": "machine-idle", "kind": "zone_idle", "zoneId": "work-zone", "motionThreshold": 2},
        ]

        moving = self.evaluate(
            1.0,
            [],
            signals,
            zone_metrics={"work-zone": {"initialized": True, "motionScore": 4.5}},
        )["signals"]
        idle = self.evaluate(
            2.0,
            [],
            signals,
            zone_metrics={"work-zone": {"initialized": True, "motionScore": 0.2}},
        )["signals"]
        self.assertTrue(moving[0]["active"])
        self.assertFalse(moving[1]["active"])
        self.assertFalse(idle[0]["active"])
        self.assertTrue(idle[1]["active"])

    def test_zone_entry_count_is_cumulative_and_rules_compare_numeric_values(self):
        signal = [{
            "id": "parts-counted",
            "kind": "object_entered_roi",
            "className": "bottle",
            "zoneId": "work-zone",
        }]
        rules = [{
            "id": "target-reached",
            "name": "Target Reached",
            "output": "COUNT_TARGET_REACHED",
            "conditions": [{"signalId": "parts-counted", "operator": "GREATER_THAN", "value": 1}],
        }]

        self.evaluate(1.0, [], signal, rules)
        first = [{
            "trackId": 11,
            "className": "bottle",
            "confidence": 0.9,
            "box": [30, 30, 40, 50],
            "modelId": "yolo11n",
            "task": "detect",
        }]
        first_result = self.evaluate(2.0, first, signal, rules)
        self.evaluate(3.0, [], signal, rules)
        second = [{**first[0], "trackId": 12}]
        second_result = self.evaluate(4.0, second, signal, rules)

        self.assertEqual(first_result["signals"][0]["value"], 1)
        self.assertEqual(second_result["signals"][0]["value"], 2)
        self.assertTrue(second_result["rules"][0]["active"])
        self.assertEqual(second_result["rules"][0]["conditions"][0]["actualValue"], 2)

    def test_supervision_zone_membership_is_authoritative_for_roi_signals(self):
        signal = [{
            "id": "person-in-zone",
            "kind": "object_in_roi",
            "className": "person",
            "zoneId": "work-zone",
        }]
        outside_box_marked_inside = [{
            "trackId": 21,
            "className": "person",
            "confidence": 0.9,
            "box": [0, 0, 10, 10],
            "modelId": "yolo11n",
            "task": "detect",
            "zoneIds": ["work-zone"],
            "spatialEngine": "supervision-polygon-zone",
        }]
        inside_box_marked_outside = [{
            **outside_box_marked_inside[0],
            "trackId": 22,
            "box": [30, 30, 60, 60],
            "zoneIds": [],
        }]

        active = self.evaluate(1.0, outside_box_marked_inside, signal)["signals"][0]
        inactive = self.evaluate(2.0, inside_box_marked_outside, signal)["signals"][0]
        self.assertTrue(active["active"])
        self.assertEqual(active["evidence"]["spatialEngine"], "supervision-polygon-zone")
        self.assertFalse(inactive["active"])

    def test_cumulative_count_waits_for_a_confirmed_tracker_id(self):
        signal = [{
            "id": "parts-counted",
            "kind": "object_entered_roi",
            "className": "bottle",
            "zoneId": "work-zone",
        }]
        pending = [{
            "trackId": "pending-0",
            "trackConfirmed": False,
            "className": "bottle",
            "confidence": 0.9,
            "box": [30, 30, 40, 50],
            "modelId": "yolo11n",
            "task": "detect",
        }]
        confirmed = [{**pending[0], "trackId": 31, "trackConfirmed": True}]

        self.evaluate(1.0, [], signal)
        pending_result = self.evaluate(2.0, pending, signal)["signals"][0]
        confirmed_result = self.evaluate(3.0, confirmed, signal)["signals"][0]
        stable_result = self.evaluate(4.0, confirmed, signal)["signals"][0]
        self.assertEqual(pending_result["value"], 0)
        self.assertEqual(pending_result["evidence"]["pendingTrackCount"], 1)
        self.assertEqual(confirmed_result["value"], 1)
        self.assertEqual(stable_result["value"], 1)

    def test_analysis_scope_disables_signal_and_rule_without_false_absence_alert(self):
        signals = [{
            "id": "operator-present",
            "name": "Operator Present",
            "kind": "object_in_roi",
            "className": "person",
            "zoneId": "work-zone",
            "analysisEnabled": False,
        }]
        rules = [{
            "id": "operator-absent",
            "name": "Operator Absent",
            "output": "OPERATOR_ABSENT",
            "analysisEnabled": False,
            "conditions": [{"signalId": "operator-present", "operator": "IS_NOT_ACTIVE"}],
        }]

        result = self.evaluate(1.0, [], signals, rules)

        self.assertFalse(result["signals"][0]["active"])
        self.assertIn("selected analysis ROI", result["signals"][0]["evidence"]["summary"])
        self.assertFalse(result["rules"][0]["matched"])
        self.assertFalse(result["rules"][0]["active"])
        self.assertEqual(result["outputs"], [])

    def test_line_crossing_signal_exposes_directional_counts_and_drives_numeric_rule(self):
        signals = [{
            "id": "conveyor-count",
            "name": "Conveyor Line Crossings",
            "kind": "line_crossing_count",
            "className": "object",
            "zoneId": "work-zone",
            "lineId": "line-1",
        }]
        rules = [{
            "id": "target",
            "name": "Target",
            "output": "COUNT_TARGET_REACHED",
            "conditions": [{"signalId": "conveyor-count", "operator": "GREATER_THAN", "value": 2}],
        }]
        result = self.engine.evaluate(
            camera_id="cam-1",
            timestamp=12.0,
            width=100,
            height=100,
            detections=[],
            zones=[self.zone],
            signal_definitions=signals,
            rules=rules,
            counting_metrics={
                "conveyor-count": {
                    "configured": True,
                    "lineId": "line-1",
                    "zoneId": "work-zone",
                    "inboundCount": 2,
                    "outboundCount": 1,
                    "totalCount": 3,
                    "lastDirection": "outbound",
                    "crossedThisFrame": 1,
                    "crossings": [{"id": "event", "direction": "outbound"}],
                    "liveTracks": [{"trackId": 8}],
                }
            },
        )

        signal = result["signals"][0]
        self.assertEqual(signal["value"], 3)
        self.assertTrue(signal["active"])
        self.assertEqual(signal["evidence"]["inboundCount"], 2)
        self.assertEqual(signal["evidence"]["outboundCount"], 1)
        self.assertEqual(signal["evidence"]["lastDirection"], "outbound")
        self.assertTrue(result["rules"][0]["active"])


if __name__ == "__main__":
    unittest.main()
