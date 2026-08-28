# MCP-X evaluation report

Generated 2026-08-28T22:25:10.273Z · mode `fixture` · planner `fixture` · 15 scenarios × 3 runs · 0.0s

**12/15 scenarios passed — 3 failed.**

> **Variance was not measured in this run.**
>
> Planner responses were replayed from recorded fixtures, so every repeat is identical
> by construction. A stability figure from this mode would be an artefact of the replay,
> not a property of the model. Run `npm run eval:live` to measure real cross-run variance.

## Suite totals

| Metric | Value |
|---|---|
| Scenario pass rate | 80% |
| Task completion rate | 100% |
| Plan validity (valid DAG first try) | 100% |
| Capability F1 | 0.96 |
| Step efficiency | 0.95 |
| Cross-run stability | not measurable (fixture replay) |
| Tokens | 17166 in / 9948 out |

## Per scenario

| Scenario | Result | Complete | Valid DAG | Recall | Precision | Steps | Efficiency | Stable |
|---|---|---|---|---|---|---|---|---|
| `add-two-numbers` | pass | 100% | 100% | 100% | 100% | 2.0 / 3 | 0.50 | n/a |
| `backlog-triage` | pass | 100% | 100% | 100% | 100% | 3.0 / 6 | 1.00 | n/a |
| `compare-suppliers` | **FAIL** | 100% | 100% | 100% | 67% | 3.0 / 7 | 1.00 | n/a |
| `compliance-check` | **FAIL** | 100% | 100% | 67% | 100% | 4.0 / 8 | 1.00 | n/a |
| `expense-summary` | pass | 100% | 100% | 100% | 100% | 3.0 / 6 | 1.00 | n/a |
| `hn-summary-to-twitter` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 | n/a |
| `incident-postmortem` | pass | 100% | 100% | 100% | 100% | 4.0 / 9 | 1.00 | n/a |
| `inventory-audit` | pass | 100% | 100% | 100% | 100% | 4.0 / 7 | 0.75 | n/a |
| `newsletter-curation` | pass | 100% | 100% | 100% | 100% | 4.0 / 9 | 1.00 | n/a |
| `price-monitor-alert` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `release-announcement` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `shipment-eta-notify` | **FAIL** | 100% | 100% | 67% | 100% | 3.0 / 8 | 1.00 | n/a |
| `standup-digest` | pass | 100% | 100% | 100% | 100% | 4.0 / 8 | 1.00 | n/a |
| `supplier-scorecard` | pass | 100% | 100% | 100% | 100% | 3.0 / 7 | 1.00 | n/a |
| `warehouse-restock` | pass | 100% | 100% | 100% | 100% | 3.0 / 8 | 1.00 | n/a |

## Failures

### `compare-suppliers`

Goal: compare our three suppliers on lead time and unit price, and rank them

- capability precision 67% (unnecessary work)
- did not end on compute

### `compliance-check`

Goal: validate this week's shipment records against compliance rules and report any breaches

- capability recall 67%
- did not end on publish

### `shipment-eta-notify`

Goal: look up the delayed shipments, work out revised delivery dates, and email the customers

- capability recall 67%
- did not end on publish

