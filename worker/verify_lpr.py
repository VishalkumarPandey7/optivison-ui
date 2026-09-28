from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the external Indian_LPR runtime used by OptiVision.")
    parser.add_argument("--lpr-root", required=True)
    args = parser.parse_args()

    root = Path(args.lpr_root).expanduser().resolve()
    required = [root / "weights" / "best_od.pth", root / "weights" / "best_lprnet.pth"]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing required LPR weights: " + ", ".join(missing))

    os.environ["OPTIVISION_LPR_ROOT"] = str(root)
    from lpr_runtime import IndianLprRuntime

    runtime = IndianLprRuntime()
    runtime._load()
    print(f"Indian_LPR verified: {root}")
    print("Detector and LPRNet OCR weights loaded successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
