import unittest

import numpy as np
import supervision as sv

from conveyor import (
    ConveyorCountingRuntime,
    MotionProposalGenerator,
    StableLineCounter,
    StableMotionPassCounter,
    detector_proposals,
)


def tracked_detection(y: float, track_id: int = 1, x: float = 50) -> sv.Detections:
    return sv.Detections(
        xyxy=np.array([[x - 5, y - 5, x + 5, y + 5]], dtype=float),
        confidence=np.array([0.9]),
        class_id=np.array([0]),
        tracker_id=np.array([track_id]),
        data={"source": np.array(["test-detector"], dtype=object)},
    )


class ConveyorCountingTest(unittest.TestCase):
    def test_direction_reverses_when_line_orientation_reverses(self):
        left_to_right = StableLineCounter((0, 50), (100, 50))
        right_to_left = StableLineCounter((100, 50), (0, 50))

        for frame, y in enumerate([25, 35, 45, 55, 65, 75]):
            left_snapshot = left_to_right.process(tracked_detection(y), frame)
            right_snapshot = right_to_left.process(tracked_detection(y), frame)

        self.assertEqual((left_snapshot["inboundCount"], left_snapshot["outboundCount"]), (0, 1))
        self.assertEqual((right_snapshot["inboundCount"], right_snapshot["outboundCount"]), (1, 0))

    def test_stable_track_is_counted_once_despite_recrossing_and_jitter(self):
        counter = StableLineCounter((0, 50), (100, 50), minimum_movement=4)
        for frame, y in enumerate([25, 35, 45, 55, 65, 55, 45, 55, 65]):
            snapshot = counter.process(tracked_detection(y), frame)

        self.assertEqual(snapshot["totalCount"], 1)
        self.assertEqual(len(snapshot["crossings"]), 1)

        jitter = StableLineCounter((0, 50), (100, 50), minimum_movement=8)
        for frame, y in enumerate([49, 51, 49, 51, 49, 51, 50]):
            jitter_snapshot = jitter.process(tracked_detection(y), frame)
        self.assertEqual(jitter_snapshot["totalCount"], 0)

    def test_crossing_is_confirmed_after_track_becomes_stable(self):
        counter = StableLineCounter((0, 50), (100, 50), minimum_seen_frames=3, minimum_movement=4)

        first = counter.process(tracked_detection(45), 1)
        crossing = counter.process(tracked_detection(55), 2)
        confirmed = counter.process(tracked_detection(65), 3)

        self.assertEqual(first["totalCount"], 0)
        self.assertEqual(crossing["totalCount"], 0)
        self.assertEqual(confirmed["totalCount"], 1)
        self.assertEqual(confirmed["crossedThisFrame"], 1)
        self.assertEqual(confirmed["crossings"][0]["passNumber"], 1)

    def test_each_new_object_gets_the_next_pass_number(self):
        counter = StableLineCounter((0, 50), (100, 50), minimum_seen_frames=3, minimum_movement=4)

        timestamp = 0
        for track_id in (11, 22, 33):
            for y in (45, 55, 65):
                timestamp += 1
                snapshot = counter.process(tracked_detection(y, track_id=track_id), timestamp)

        self.assertEqual(snapshot["totalCount"], 3)
        self.assertEqual(
            [event["passNumber"] for event in reversed(snapshot["crossings"])],
            [1, 2, 3],
        )

    def test_direct_motion_counter_counts_without_a_line_crossing(self):
        counter = StableMotionPassCounter(minimum_seen_frames=2, minimum_movement=2)

        first = counter.process(tracked_detection(20, track_id=7), 1)
        passed = counter.process(tracked_detection(30, track_id=7), 2)
        later = counter.process(tracked_detection(60, track_id=7), 3)

        self.assertEqual(first["totalCount"], 0)
        self.assertEqual(passed["totalCount"], 1)
        self.assertEqual(passed["crossings"][0]["passNumber"], 1)
        self.assertEqual(later["totalCount"], 1)
        self.assertEqual(later["countingMode"], "direct-motion-zone")

    def test_detector_proposals_are_restricted_to_the_counting_roi(self):
        detections = [
            {"id": "inside", "box": [10, 10, 20, 20], "confidence": 0.8, "task": "detect", "modelId": "yolo", "zoneIds": ["counting-zone"]},
            {"id": "outside", "box": [70, 70, 80, 80], "confidence": 0.9, "task": "detect", "modelId": "yolo", "zoneIds": ["other-zone"]},
            {"id": "pose", "box": [10, 10, 20, 20], "confidence": 0.9, "task": "pose", "modelId": "pose", "zoneIds": ["counting-zone"]},
        ]

        proposals = detector_proposals(detections, "counting-zone")

        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["source"], "yolo:yolo")

    def test_motion_fallback_emits_generic_boxes_only_inside_roi(self):
        generator = MotionProposalGenerator()
        zone = {"id": "counting-zone", "x": 25, "y": 25, "width": 50, "height": 50, "coordinateSpace": "percent"}
        first = np.zeros((200, 200, 3), dtype=np.uint8)
        second = first.copy()
        second[80:120, 85:115] = 255
        second[0:30, 0:30] = 255

        self.assertEqual(generator.analyze("cam-1", first, zone), [])
        proposals = generator.analyze("cam-1", second, zone)

        self.assertTrue(proposals)
        self.assertTrue(all(50 <= value <= 150 for proposal in proposals for value in proposal["box"]))
        self.assertTrue(all(proposal["source"] == "motion-fallback" for proposal in proposals))

        third = second.copy()
        third[80:120, 100:130] = 255
        analysis = generator.analyze_with_mask("cam-1", third, zone)
        self.assertTrue(analysis.mask_data_url.startswith("data:image/png;base64,"))
        self.assertGreater(analysis.foreground_percent, 0)

    def test_counting_zone_is_ready_without_a_directional_line(self):
        runtime = ConveyorCountingRuntime()
        zone = {"id": "zone", "x": 10, "y": 10, "width": 80, "height": 80, "coordinateSpace": "percent"}
        image = np.zeros((100, 100, 3), dtype=np.uint8)

        metrics, _ = runtime.analyze(
            camera_id="cam-1",
            timestamp=1,
            image=image,
            detections=[],
            zones=[zone],
            counting_lines=[],
            signal_definitions=[{
                "id": "count",
                "kind": "line_crossing_count",
                "zoneId": "zone",
                "lineId": "missing-line",
                "analysisEnabled": True,
            }],
        )

        self.assertTrue(metrics["count"]["configured"])
        self.assertEqual(metrics["count"]["countingMode"], "direct-motion-zone")
        self.assertTrue(metrics["count"]["motionMask"].startswith("data:image/png;base64,"))

    def test_runtime_counts_a_moving_white_foreground_object_directly(self):
        runtime = ConveyorCountingRuntime()
        zone = {"id": "zone", "x": 0, "y": 0, "width": 100, "height": 100, "coordinateSpace": "percent"}
        signal = {"id": "count", "kind": "line_crossing_count", "zoneId": "zone", "analysisEnabled": True}
        totals = []
        debug = []

        for frame_index, object_x in enumerate((None, 8, 16, 24, 32, 40, 48), start=1):
            image = np.zeros((120, 160, 3), dtype=np.uint8)
            if object_x is not None:
                image[45:75, object_x:object_x + 28] = 255
            metrics, _ = runtime.analyze(
                camera_id="cam-direct",
                timestamp=float(frame_index),
                image=image,
                detections=[],
                zones=[zone],
                counting_lines=[],
                signal_definitions=[signal],
            )
            totals.append(metrics["count"]["totalCount"])
            debug.append((
                metrics["count"]["foregroundPercent"],
                [(track["trackId"], track["seenFrames"], track["displacement"]) for track in metrics["count"]["liveTracks"]],
            ))

        self.assertGreaterEqual(totals[-1], 1, debug)
        self.assertEqual(totals, sorted(totals))

    def test_counter_state_and_reset_are_isolated_per_camera(self):
        runtime = ConveyorCountingRuntime()
        line = {"id": "line", "zoneId": "zone", "start": {"x": 100, "y": 50}, "end": {"x": 0, "y": 50}, "coordinateSpace": "percent"}
        zone = {"id": "zone", "x": 0, "y": 0, "width": 100, "height": 100, "coordinateSpace": "percent"}
        first = runtime._state("cam-1", "line", line, zone, 100, 100)
        second = runtime._state("cam-2", "line", line, zone, 100, 100)

        for frame, y in enumerate([25, 35, 45, 55, 65, 75]):
            first_snapshot = first.counter.process(tracked_detection(y), frame)
        second_snapshot = second.counter.process(sv.Detections.empty(), 10)

        self.assertEqual(first_snapshot["totalCount"], 1)
        self.assertEqual(second_snapshot["totalCount"], 0)
        runtime.reset("cam-1")
        self.assertNotIn(("cam-1", "line"), runtime.states)
        self.assertIn(("cam-2", "line"), runtime.states)


if __name__ == "__main__":
    unittest.main()
