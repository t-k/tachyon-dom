import json
from pathlib import Path
from statistics import median
import sys

root = Path(sys.argv[1])
pairs = [
    [json.loads((root / f"{subject}-{pair}.json").read_text()) for subject in ("base", "candidate")]
    for pair in range(1, 8)
]
print("| Workload | Baseline CPU (µs) | Candidate CPU (µs) | Paired CPU change | Paired wall change | CPU faster pairs |")
print("| --- | ---: | ---: | ---: | ---: | ---: |")
for name, first in pairs[0][0].items():
    for base, candidate in pairs:
        assert first["hash"] == base[name]["hash"] == candidate[name]["hash"], name
    cpu = [candidate[name]["cpuMicros"] / base[name]["cpuMicros"] - 1 for base, candidate in pairs]
    wall = [candidate[name]["wallMicros"] / base[name]["wallMicros"] - 1 for base, candidate in pairs]
    baseline = median(base[name]["cpuMicros"] for base, _ in pairs)
    changed = median(candidate[name]["cpuMicros"] for _, candidate in pairs)
    faster = sum(change < 0 for change in cpu)
    print(f"| {name} | {baseline:.2f} | {changed:.2f} | {median(cpu):+.1%} | {median(wall):+.1%} | {faster}/7 |")
