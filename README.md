# 道路救援定位目录与合作车队
本地来源使用虚构的点位、机构、车队和救援单。公里数是点位属性。业务目录不会要求按公里数反算点位。
使用 Node.js 22.23.4，执行 `npm ci` 后运行 `npm start`。来源默认监听本机 4173，可通过 `PORT` 调整。运行 `npm test` 校验来源交互。演练数据在 `samples/`。
## 管理方来源
`GET /sources` 给出各地区目录首页、更新地址及已公布的游标。流水以地区和签发方为单位编号，收到的 nextCursor 须连同对应的签发方使用。各全量册页的 edition 和 through 表示同一切面及包含的各签发方末笔。目录默认只列现行及明确停用的绑定，继续页没有重复标题的兼容保证。HTTP 409 会指出可重新取得的首页，410 表示该来源的游标已过期。绑定的标识是 binding，点位标识是 point。retire 指向原 binding；替代码是源方候选，只有交接声明中为对应点位批准的代码才可用。
`GET /handoffs` 给出书面交接范围和末笔、起笔。相同的交接记录可以随多个视图重送。独立区域有各自的公布进度。
## 接线台和合作车队
`GET /control/jobs` 给出接线台实际在办或已结清的救援单，同时保留分配时的绑定编号。入口 `GET /fleets` 提供车队可用于查号的字段及共享目录收纳的签发方。一个车队只有一本可见通讯录，即使它接收多个签发方。
`GET /fleet/{id}/directory` 读取当前目录及 revision。`POST /fleet/{id}/send` 接收 JSON，含 base（该车队目录版）、transmission（调用方选定的传输标识）和 actions。每条 action 含 op（upsert 或 remove）和 binding 对象。写入的对象包含 binding、point、code、issuer，删除只需 binding 标识。目录按车队公布的 key 字段查找，upsert 会替换该键已有内容。服务按相同传输标识回读既有结果，传输号相同而内容不同时返回 409。服务也会因 base 过时返回 409。
回执的 accepted 和 rejected 是车队逐条实收结果，混合结果返回 207。GET /fleet/{id}/receipts?transmission=… 按传输号读取回执，202 表示回执还不可见。目录中的条目和目录版本来自车队自身，可能先于回执更新。服务重启将恢复演练的初始车队状态。
来源发布时间用 `PUT /replay` 和 JSON `{"step":1}` 切换，`GET /ready` 或 `GET /health` 返回当前序号与总轮数。切换来源发布时间不重置车队目录与回执。演练从第 0 轮开始。
## 目录采集与交接服务
`npm run start:intake` 启动采集与交接服务（默认本机 4180，`INTAKE_PORT` 调整；`SOURCE_URL` 指向资料源，默认 http://127.0.0.1:4173）。`POST /sync` 执行一轮采集与投递，其余接口只读：

- `GET /areas`：各地区采集状态——全量册切面（edition/through）、各签发方游标、预收笔数、是否待重收（resync）与分段未齐（fullState=incomplete）、已核实的交接声明。
- `GET /lookup?area=&issuer=&code=`、`GET /points/{point}`：绑定查询。结果区分 `active`（现行）、`retired`（明确停用）、`incomplete`（分段未齐：仅预收或切面未收齐）、`unknown`（暂时查不到，404）；`stale` 表示该地区正待按切面重收。旧表漏行不算注销，只有明确 retire 才停用。
- `GET /plan?point=`：派车就绪视图。每个车队给出 `ready`（码可用，含应读出的码或替代码）、`awaiting-source`（等源目录收齐）、`awaiting-job`（前单未结且替代码未获准，只暂停该车队此点）、`awaiting-confirm`（等终端确认或接受）。
- `GET /jobs`、`GET /jobs/{id}`：救援单及分配时快照（当时车队所用的绑定、码和点位），结单后仍可查。
- `GET /fleets`：各车队目录回读、逐绑定投递状态（confirmed/sent/rejected，回执或回读证实）、暂停点位、传输回执。
- `GET /conflicts`：按终端实际可区分范围（各车队键字段）发现的短码冲突及处置（alias/pause/conflict），包括一个终端合用多部门通讯录的情形。

采集规则：全量册同一批页的 edition/through 必须一致，翻页中途换版（409）从首页重收，不拼接两个版本；收齐后用 through 推进各签发方游标，切面之后的新变动由流水跟随补上。序列缺口、失效游标（410）、转发方重送都转为按源方证实的切面重新收齐。旧方停发后新方增量可先到，未取得交接声明的一侧只预收；声明须覆盖对应地区、旧方末笔和新方起笔，核实后预收转正。替代码以交接声明批准为准，流水里的 replacementCode 只是候选。投递按车队实际回执与目录回查核实（回执可能暂缓可见、目录可能先于回执更新）；撤回只带 binding 标识，不靠当前短码牵连他点。
