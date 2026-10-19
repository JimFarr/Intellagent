# More boards

Each `*.yml` here is one more board for Prometheus to scrape, beside the one in `../prometheus.yml`
(Prometheus reads them through `scrape_config_files`). A board's file and its token stay on this machine:
both are git-ignored.

For each board:
1. In its manifest: `"metrics": { "prometheus": true }` and `"allowedHosts": ["host.docker.internal"]`; restart it.
2. In its folder: `intellagent token --metrics`, and save the token as `<name>.token` here.
3. Write `<name>.yml` here: a `job_name`, its port, `credentials_file: /etc/prometheus/boards/<name>.token`,
   and, since every board's id is usually `main`, a `metric_relabel_configs` rule renaming its `board` label to
   `<name>` so the dashboard's board picker keeps them apart. `lenza.yml` (if present) is an example.
4. `docker compose restart prometheus`.
