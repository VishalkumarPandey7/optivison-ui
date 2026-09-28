import unittest

import numpy as np
import supervision as sv

from server import filter_detections_to_analysis_rois, requested_model_class_ids, supervision_zone_memberships


class SupervisionPipelineTest(unittest.TestCase):
    def test_requested_class_names_are_mapped_to_model_ids(self):
        names = {0: "person", 2: "car", 67: "cell phone"}

        self.assertEqual(requested_model_class_ids(names, ["PERSON", "cell phone"]), [0, 67])
        self.assertEqual(requested_model_class_ids(names, ["helmet"]), [])
        self.assertIsNone(requested_model_class_ids(names, None))

    def test_roi_membership_requires_minimum_box_overlap(self):
        detections = sv.Detections(
            xyxy=np.array([
                [30.0, 30.0, 60.0, 60.0],
                [0.0, 0.0, 30.0, 30.0],
                [0.0, 0.0, 50.0, 50.0],
            ]),
            confidence=np.array([0.9, 0.8, 0.85]),
            class_id=np.array([0, 0, 0]),
        )
        zones = [{
            "id": "work-zone",
            "x": 20,
            "y": 20,
            "width": 60,
            "height": 60,
            "coordinateSpace": "percent",
        }]

        strict_memberships = supervision_zone_memberships(detections, zones, 100, 100, 0.5)
        relaxed_memberships = supervision_zone_memberships(detections, zones, 100, 100, 0.3)

        self.assertEqual(strict_memberships, [["work-zone"], [], []])
        self.assertEqual(relaxed_memberships, [["work-zone"], [], ["work-zone"]])

    def test_selected_analysis_rois_filter_before_signal_evaluation(self):
        detections = [
            {"id": "operator", "zoneIds": ["operator-zone"]},
            {"id": "machine", "zoneIds": ["machine-zone"]},
            {"id": "outside", "zoneIds": []},
        ]

        filtered = filter_detections_to_analysis_rois(detections, {"operator-zone"})

        self.assertEqual([item["id"] for item in filtered], ["operator"])

    def test_empty_analysis_roi_selection_rejects_full_frame_detections(self):
        detections = [{"id": "outside", "zoneIds": []}]

        self.assertEqual(filter_detections_to_analysis_rois(detections, set()), [])


if __name__ == "__main__":
    unittest.main()
