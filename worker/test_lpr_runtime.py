import unittest

import numpy as np

from lpr_runtime import IndianLprRuntime, _box_iou


class FakeIndianLprRuntime(IndianLprRuntime):
    def __init__(self, detections):
        super().__init__()
        self._detector = object()
        self._recognizer = object()
        self._decode = lambda _recognizer, crops: ["KA02MN1826"] * len(crops)
        self.detections = iter(detections)
        self.detect_calls = 0

    def _detect(self, image):
        del image
        self.detect_calls += 1
        return next(self.detections)


class IndianLprRuntimeTests(unittest.TestCase):
    def test_plate_zone_fallback_maps_enlarged_box_to_original_frame(self):
        runtime = FakeIndianLprRuntime([
            ([[30, 30, 150, 60]], [0.88]),
        ])
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        zones = [{"id": "plate-zone", "name": "Number Plate Zone", "x": 25, "y": 20, "width": 50, "height": 60}]

        results = runtime.analyze(image, zones, 0.5)

        self.assertEqual(runtime.detect_calls, 1)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["plateText"], "KA02MN1826")
        self.assertEqual(results[0]["box"], [60, 30, 100, 40])
        self.assertEqual(results[0]["zoneIds"], ["plate-zone"])

    def test_full_frame_detection_does_not_run_fallback(self):
        runtime = FakeIndianLprRuntime([
            ([[20, 20, 80, 40]], [0.91]),
        ])
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        zones = [{"id": "plate-zone", "name": "Number Plate Zone", "x": 0, "y": 0, "width": 100, "height": 100}]

        results = runtime.analyze(image, zones, 0.5)

        self.assertEqual(runtime.detect_calls, 1)
        self.assertEqual(results[0]["box"], [20, 20, 80, 40])

    def test_explicit_plate_zone_is_the_detector_input(self):
        runtime = FakeIndianLprRuntime([
            ([], []),
        ])
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        zones = [{"id": "number-plate-zone", "name": "Number Plate Zone", "x": 0, "y": 0, "width": 50, "height": 60}]

        results = runtime.analyze(image, zones, 0.5)

        self.assertEqual(runtime.detect_calls, 1)
        self.assertEqual(results, [])

    def test_non_plate_zone_does_not_disable_whole_frame_lpr(self):
        runtime = FakeIndianLprRuntime([
            ([[120, 70, 180, 90]], [0.91]),
        ])
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        zones = [{"id": "worker-zone", "name": "Worker Zone", "x": 0, "y": 0, "width": 50, "height": 60}]

        results = runtime.analyze(image, zones, 0.5)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["zoneIds"], [])

    def test_box_iou_rejects_duplicates(self):
        self.assertGreater(_box_iou([10, 10, 30, 30], [11, 11, 29, 29]), 0.65)
        self.assertEqual(_box_iou([0, 0, 10, 10], [20, 20, 30, 30]), 0)


if __name__ == "__main__":
    unittest.main()
