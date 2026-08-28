# MCP-X evaluation report

Generated 2026-08-28T23:34:46.750Z · mode `fixture` · planner `fixture` · 15 scenarios × 3 runs · 0.0s

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
| Capability F1 | 0.99 |
| Step efficiency | 0.98 |
| Cross-run stability | not measurable (fixture replay) |
| Tokens | 22881 in / 8598 out |

## Per scenario

| Scenario | Result | Complete | Valid DAG | Recall | Precision | Steps | Efficiency | Stable |
|---|---|---|---|---|---|---|---|---|
| `add-two-numbers` | pass | 100% | 100% | 100% | 100% | 1.0 / 3 | 1.00 | n/a |
| `backlog-triage` | pass | 100% | 100% | 100% | 100% | 3.0 / 6 | 1.00 | n/a |
| `compare-suppliers` | pass | 100% | 100% | 100% | 100% | 3.0 / 7 | 1.00 | n/a |
| `compliance-check` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 | n/a |
| `expense-summary` | pass | 100% | 100% | 100% | 100% | 2.0 / 6 | 1.00 | n/a |
| `hn-summary-to-twitter` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 | n/a |
| `incident-postmortem` | pass | 100% | 100% | 100% | 100% | 3.0 / 9 | 1.00 | n/a |
| `inventory-audit` | pass | 100% | 100% | 100% | 100% | 4.0 / 7 | 0.75 | n/a |
| `newsletter-curation` | **FAIL** | 100% | 100% | 67% | 100% | 3.0 / 9 | 1.00 | n/a |
| `price-monitor-alert` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `release-announcement` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `shipment-eta-notify` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 | n/a |
| `standup-digest` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `supplier-scorecard` | pass | 100% | 100% | 100% | 100% | 3.0 / 7 | 1.00 | n/a |
| `warehouse-restock` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 | n/a |

## Failures

### `newsletter-curation`

Goal: find this week's most discussed engineering articles, summarise each, and publish the newsletter

- capability recall 67%
- did not end on publish

