# Intellagent in Grafana

The board can serve its numbers to Prometheus at `GET /metrics`, and `intellagent.json` here is a dashboard for them. Prometheus keeps the history; the board only reports where things stand now.

## 1. Switch it on

It is off until you say so, and then it asks for a token.

1. In the board's manifest (`intellagent.manifest.json`, in `.intellagent/` in a project), add:
   ```json
   "metrics": { "prometheus": true }
   ```
2. Issue the metrics token, from your own terminal (an agent cannot):
   ```
   intellagent token --metrics
   ```
   It is saved in `local.json` (git-ignored) and printed once. `--rotate` replaces it; the board accepts the new one at once.
3. Restart the board (`intellagent stop`, then `intellagent start`) so it reads the manifest.

The metrics token opens `GET /metrics` and nothing else: it is no use on the board's API, and it never appears in the output. Without it the route answers `401`; with `metrics.prometheus` off it answers `404`, naming the switch.

## 2. Scrape it

Save the token in a file Prometheus can read, e.g. `intellagent-metrics.token`, and add this to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: intellagent
    scrape_interval: 30s
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/intellagent-metrics.token
    static_configs:
      - targets: ["127.0.0.1:7420"]
```

Use the board's own port in place of `7420`. The board answers only to its own host names, so Prometheus must reach it as `127.0.0.1` or `localhost` (or add the name to `allowedHosts` in the manifest). Check by hand:

```
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7420/metrics
```

## 3. Import the dashboard

In Grafana: **Dashboards › New › Import**, upload `docs/grafana/intellagent.json`, and pick your Prometheus data source when it asks. Set the **Board** variable if you run more than one.

It has three rows: **Flow** (tickets per column, done per day, cycle time p50/p90, landings), **Agents** (status timeline, runs by result, run time, tokens per model, estimated cost, usage-limit holds) and **Waiting on the human** (open questions, the oldest wait).

The **estimated cost** multiplies tokens by the prices in the dashboard's variables (USD per million tokens). The defaults are placeholders: set your own per model family, because the board does not know what you pay.

## What is exposed

Every series per board carries `board`. No ticket title, comment or question text is ever a label.

| Series | Type | Labels |
|---|---|---|
| `intellagent_tickets` | gauge | `board`, `column` |
| `intellagent_tickets_done_total` | counter | `board` |
| `intellagent_cycle_seconds` | histogram | `board` |
| `intellagent_questions_open` | gauge | `board`, `kind` (`question`, `review`) |
| `intellagent_question_oldest_seconds` | gauge | `board` |
| `intellagent_reviews_decided` | gauge | `board`, `verdict` (`approve`, `changes`), `delegated` |
| `intellagent_landings` | gauge | `board`, `result` (`landed`, `failed`, `hand`) |
| `intellagent_idle_alarms` | gauge | `board` |
| `intellagent_leases_active` | gauge | `board` |
| `intellagent_agent_status` | gauge | `agent`, `model`, `provider`, `status` (1 for the current one) |
| `intellagent_agent_queue` | gauge | `agent`, `model`, `provider` |
| `intellagent_agent_runs_total` | counter | `agent`, `result` (`ok`, `failed`, `timeout`, `stopped`, `limited`) |
| `intellagent_agent_run_seconds` | histogram | `agent` |
| `intellagent_agent_tokens_total` | counter | `agent`, `model`, `kind` (`input`, `output`, `cache_read`, `cache_write`) |
| `intellagent_agent_usage_limited_total` | counter | `agent` |
| `intellagent_usage_limit_until_seconds` | gauge | `agent`, `model`, `provider` (Unix time; 0 when not held) |
| `intellagent_events_total` | counter | none |
| `intellagent_up`, `intellagent_build_info` | gauge | none; `version`, `build` |

Counters come from state the board keeps (the tickets, and the run records in `data/agent-stats.jsonl`), so they survive a restart. Three are **gauges**, not counters, because they are worked out from the tickets as they stand: `reviews_decided` counts each ticket under its latest verdict, `landings` under its latest landing, and `idle_alarms` is the alarms kept on the board (the newest 500). A ticket decided again, or a failed landing that later succeeds, moves from one label to another, so a value can step down. Read them as they are; do not use `rate()` or `increase()` on them.
