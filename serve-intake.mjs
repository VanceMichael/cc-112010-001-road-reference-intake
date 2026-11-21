import { createIntakeService } from './intake/service.mjs'

const port = Number(process.env.INTAKE_PORT ?? 4180)
const source = process.env.SOURCE_URL ?? 'http://127.0.0.1:4173'
const service = createIntakeService({ source })
service.listen(port, '127.0.0.1', () =>
  console.log(`目录采集与交接服务已启动 http://127.0.0.1:${service.address().port}（来源 ${source}）`))
