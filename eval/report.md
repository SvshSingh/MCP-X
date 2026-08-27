# MCP-X evaluation report

Generated 2026-08-27T16:47:17.143Z · mode `fixture` · planner `fixture` · 15 scenarios × 3 runs · 0.1s

**14/15 scenarios passed — 1 failed.**

> **Variance was not measured in this run.**
>
> Planner responses were replayed from recorded fixtures, so every repeat is identical
> by construction. A stability figure from this mode would be an artefact of the replay,
> not a property of the model. Run `npm run eval:live` to measure real cross-run variance.

## Suite totals

| Metric | Value |
|---|---|
| Scenario pass rate | 93% |
| Task completion rate | 100% |
| Plan validity (valid DAG first try) | 100% |
| Capability F1 | 0.98 |
| Step efficiency | 0.77 |
| Cross-run stability | not measurable (fixture replay) |
| Tokens | 14556 in / 12768 out |

## Per scenario

| Scenario | Result | Complete | Valid DAG | Recall | Precision | Steps | Efficiency | Stable |
|---|---|---|---|---|---|---|---|---|
| `add-two-numbers` | **FAIL** | 100% | 100% | 100% | 50% | 3.0 / 3 | 0.33 | n/a |
| `backlog-triage` | pass | 100% | 100% | 100% | 100% | 5.0 / 6 | 0.60 | n/a |
| `compare-suppliers` | pass | 100% | 100% | 100% | 100% | 6.0 / 7 | 0.50 | n/a |
| `compliance-check` | pass | 100% | 100% | 100% | 100% | 5.0 / 8 | 0.80 | n/a |
| `expense-summary` | pass | 100% | 100% | 100% | 100% | 4.0 / 6 | 0.75 | n/a |
| `hn-summary-to-twitter` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `incident-postmortem` | pass | 100% | 100% | 100% | 100% | 5.0 / 9 | 0.80 | n/a |
| `inventory-audit` | pass | 100% | 100% | 100% | 100% | 4.0 / 7 | 0.75 | n/a |
| `newsletter-curation` | pass | 100% | 100% | 100% | 100% | 5.0 / 9 | 0.80 | n/a |
| `price-monitor-alert` | pass | 100% | 100% | 100% | 100% | 5.0 / 8 | 0.80 | n/a |
| `release-announcement` | pass | 100% | 100% | 100% | 100% | 5.0 / 8 | 0.80 | n/a |
| `shipment-eta-notify` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `standup-digest` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `supplier-scorecard` | pass | 100% | 100% | 100% | 100% | 5.0 / 7 | 0.60 | n/a |
| `warehouse-restock` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |

## Failures

### `add-two-numbers`

Goal: add 2 and 3 and tell me the answer

- capability precision 50% (unnecessary work)

