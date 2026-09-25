# Issue 17: live recovery attempt, September 25, 2026

**Result: incomplete.** The installed package proved live interruption, recovery, reviews, and a genuine owner response. Integration of the live candidate did not pass. The disposable target stayed at its original commit; this attempt grants no live integration or automatic app-close claim.

## Fixed identities and limits

| Item                        | Recorded value                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Installed archive           | `@ai-hero/sandcastle@0.12.0-dv8.16.0`, SHA-256 `eca2e0116d09ac920b9ccf2e6e8d6896124c9533a83d9945066079ecead83164` |
| Package source              | `0df2ba5c91afca41294ea026a95f9e21a7ba6d73`                                                                        |
| Fixture starting commit     | `9e88a4d4b61896aefb22df8fff7801f5728770a6`                                                                        |
| Worker image                | `sha256:6669402f260401868ab26a8a17c2d591747111f9ed582ca0326ad992a1b8835d`                                         |
| Runtime identity            | `29ccb8baf77f39edcabf2e35ae0432aa8a83d50aaa8ec24ee23661a94a1f18d8`                                                |
| Provider                    | Codex CLI 0.156.1, Sol High, Standard service tier                                                                |
| Reserved calls              | Two implementation, one standards review, one specification review; all four consumed, none remaining             |
| Recorded worker active time | 344,874 ms; no individual call exceeded 15 minutes                                                                |
| Account readings            | 22% used at baseline and latest; the five-point stop and 20% reserve did not trigger                              |

The first interrupted invocation has unknown token coverage in the usage ledger. No reset, credit, benchmark budget, or fifth model call was used. The 45-minute limit also counted preparation and verification around worker activity; the attempt stopped before that cumulative limit.

## Observed sequence

1. Preflight admitted the exact archive and worker on the independent fixture. Its baseline source SHA-256 was `7a69a54d995c478c8275aacfadb3ff510ec7d26f03aabf84711bb19d5f26a7a8`.
2. The first real Codex invocation changed source bytes and produced session `01a0d73e-a4a3-7543-8e10-04f0758425b0`. The owner barrier recorded the changed source SHA-256 `76883bace85c5a1973e399a5f7fefd44f21c6996f1d20b1ca406a2ee1b27cb12` and copied genuine session bytes with SHA-256 `72bce2518ea11839c5373db6ef4e1a0559de7c4074868d155fb7b7f18c4abb05`. The verified checkpoint was `087d1b26-a41e-4cda-90fe-6790fd83206e`; sandbox `1f2a96a5c59b` was removed.
3. Recovery retained the source and session and used a new sandbox to continue that same session within the second implementation call. The candidate commit `86fbb0482726382f9ad07ed75eb7d49f92909d78` changed `items.slice(0, limit || items.length)` to `items.slice(0, limit)`. The protected grader and both fresh read-only reviews passed. The review session IDs were `01a0d743-a447-7443-ae75-3ea3dfaca84a` and `01a0d744-a8c9-7b13-b941-0404846db3cf`.
4. The workflow stopped with verified source and session restoration at checkpoint `bb5e7132-56c5-4731-8ff2-d281d9b1e974`. Request `79db886f-5d61-4a39-97d9-aff1af51905d` displayed the exact candidate, source manifest, and three evidence hashes. The owner replied `Approve` through the host terminal. Response `78254b1f-ff85-464b-9d35-5e7b1e9884f6` was applied at 06:37:31 UTC with no additional model call. The original host event is `ea6af0d6-5c6c-4c0a-9dc2-e04abed589f6` (SHA-256 `2a401c9d0b98451550c5395f9e37ba2d32ad289ed753818c774f9574c3d71b75`).
5. The live integration check reran tests, typechecking, and the protected grader, then failed with `EEXIST` while creating the existing grade evidence file. Test durations made the new bytes differ from the approved evidence. Intent `db172ea8-4486-4fae-a50b-988dff794327` is blocked; task `limit-items-zero` is blocked and stopped with restoration verified. The target remains at `9e88a4d4b61896aefb22df8fff7801f5728770a6`, with no merge effect. The frozen approval and state were left intact.

Separately, the deterministic installed-package scenario applied and integrated synthetic Task A while `independent-task-b-issue17-concurrent` was active in another project/invocation. Its overlap receipt SHA-256 is `1867b01a12f14ca430062caa077094ceaa99a2a62feef4e93b625e3407cc783a`; Task B later stopped at a waiting request with zero model calls. This establishes control isolation, not the missing live merge.

The fixture callback now writes stable check evidence at fixture commit `2705287`. That correction prepares a new attempt but cannot unblock the recorded integration intent. A fresh live run needs its own explicit execution decision and call budget.
