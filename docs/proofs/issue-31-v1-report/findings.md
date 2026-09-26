# Issue #31 v1 partial study

The host froze the five requested arms and 40-slot order. Calibration passed, and the protected base and correction preflights passed for all four historical cases. The first development slot, `stream-log-1-0` with Luna Max, is the only attempted evaluation. The remaining 39 slots were not run.

The first candidate passed the protected check. Both preliminary reviewers then reported the same fixable timing defect. A second implementation call started under the provisional review-retry protocol. The owner selected the narrower rule: reviewer findings do not authorize a retry, and a failed final review scores the evaluation as failed. The host made a verified checkpoint during that call. The slot is **incomplete**, with no measured workflow cost or model ranking. The partial report was generated after the active slot stopped; its report activity could not be charged as a completed budget activity while that slot retained recovery ownership.

The first candidate also committed `.changeset/file-log-stream-entry-boundary.md`, as this repository requires for user-facing fixes. The v1 task scope allowed only `src`, so that candidate would have failed the later scope gate. The revised host entry allows `src` and `.changeset` before any fresh manifest is frozen. The v1 state and evidence have not been changed or resumed.

The shared budget recorded 1,223,870 active milliseconds when the slot stopped. The weekly account reading moved from 49% to 50% used during this run. That coarse account reading cannot be assigned precisely to the slot or converted from Standard credit estimates. The 20-point account rise guard did not fire. Sol High remains the current policy.

The exported JSON, HTML and CSV files are byte-for-byte copies from the protected v1 host directory. `benchmark-action.json`, `slot-state.json` and `slot-usage.json` record the review finding, verified checkpoint and call usage. Keep their bytes unchanged because receipt hashes bind the frozen evidence.
