# rent-watch

白天（日本时间 8–22 点）每 20 分钟、夜里每小时查一次 SUUMO / HOME'S，现住处开车约 10 分钟范围内、以及湘南台駅徒歩 15〜25 分或巴士 9 分以内的范围内出现符合条件的新房源、降价、重新招租时，用 ntfy（免费）推送到手机。

- 条件、范围（町名列表 `towns`、车站步行圈 `stations`）在 `config.json` 里改，push 后下一次运行生效。
- `state.json` 是已见过的房源记录，由 Actions 自动提交，不要手动改。删掉它会重新发一次"现有房源一览"。
- 通知：GitHub Secrets 里设 `NTFY_TOPIC`（手机 ntfy App 订阅同名频道）。另外设了 `WXPUSHER_TOKEN`/`WXPUSHER_UID` 的话也会同时发到微信。
- 本地试跑：`npm ci` 后 `node watch.mjs --dry-run`（只打印，不推送）。
- 停车费从 SUUMO 详情页读取。HOME'S 的详情页有反爬验证读不到，只在 HOME'S 上有的房源会标"停车费请点开确认"。
- 某个网站连续失败（SUUMO 3 次 / HOME'S 24 次）会推送一条出错通知。
