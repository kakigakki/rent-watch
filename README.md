# rent-watch

每 30 分钟查一次 SUUMO / HOME'S，现住处开车约 10 分钟范围内出现符合条件的新房源、降价、重新招租时，用 WxPusher（免费）推送到微信。

- 条件、范围（町名列表）在 `config.json` 里改，push 后下一次运行生效。
- `state.json` 是已见过的房源记录，由 Actions 自动提交，不要手动改。删掉它会重新发一次"现有房源一览"。
- 本地试跑：`npm ci` 后 `node watch.mjs --dry-run`（只打印，不推送）。
- 停车费从 SUUMO 详情页读取。HOME'S 的详情页有反爬验证读不到，只在 HOME'S 上有的房源会标"停车费请点开确认"。
- 某个网站连续失败（SUUMO 3 次 / HOME'S 24 次）会推送一条出错通知。
