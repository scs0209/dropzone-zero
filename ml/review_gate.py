"""Local TabPFN review gate for Dropzone Zero.

Reads {"train": [[...]], "labels": [0|1], "test": [[...]], "categorical": [i, ...]}
as JSON on stdin and prints {"reject": [p, ...]}: for each test row, the chance
the user would move that file back. Runs entirely on this machine with the
TabPFN v2 weights (Built with TabPFN, https://priorlabs.ai).
"""

import json
import sys
import warnings

import numpy as np
from tabpfn import TabPFNClassifier
from tabpfn.constants import ModelVersion


def main() -> None:
    request = json.load(sys.stdin)
    train = np.asarray(request["train"], dtype=float)
    labels = np.asarray(request["labels"], dtype=int)
    test = np.asarray(request["test"], dtype=float)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model = TabPFNClassifier.create_default_for_version(
            ModelVersion.V2,
            device="cpu",
            categorical_features_indices=request["categorical"],
            random_state=0,
        )
        model.fit(train, labels)
        reject_column = list(model.classes_).index(1)
        reject = model.predict_proba(test)[:, reject_column]

    json.dump({"reject": [round(float(p), 4) for p in reject]}, sys.stdout)


if __name__ == "__main__":
    main()
