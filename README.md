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
