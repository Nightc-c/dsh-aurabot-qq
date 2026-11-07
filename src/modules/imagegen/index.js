// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。
//
// 画图是慢操作（十几秒到几十秒）。如果让工具卡在那里等，她这一轮就被占住了，说不了话。
// 所以工具只负责「提交任务」——立刻返回，她当场说一句「好，我这就去画」；画完由后台把图发进聊天，
// 再推回会话让她看一眼、自己说一句。这样两句话都是她在真会话里说的，工具也不会卡住。

import { readFileSync } from 'node:fs'
import { createImageGen, imageToolBlock, resolveDrawImage } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, rememberPainting, removePainting, savePainting } from '../../features/paintings.js'
import { defineTool, str } from '../../tools/tools.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/image-shape.js', 'features/paintings.js', 'features/codex-auth.js', 'features/codex-image.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local })
    const auth = gen.codexAuth
    api.onDispose?.(() => gen.dispose())
    const accountAction = (fn) => async (req) => {
      if (req?.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, message: '账号操作需要 POST JSON 请求' }
      return fn(req)
    }
    api.route('/image/codex/status', async () => ({ ok: true, ...auth.status(), login: auth.loginStatus() }))
    api.route('/image/codex/login', accountAction(async () => ({ ok: true, ...(await auth.startLogin()), ...auth.loginStatus() })))
    api.route('/image/codex/login/status', async () => ({ ok: true, ...auth.loginStatus(), ...auth.status() }))
    api.route('/image/codex/complete', accountAction(async (req) => {
      const body = await api.core.http.body(req)
      const credential = await auth.completeLogin(String(body?.input || ''))
      return { ok: true, email: credential.email || '', accountId: credential.accountId || '' }
    }))
    api.route('/image/codex/cancel', accountAction(async () => ({ ok: true, ...auth.cancelLogin('已取消') })))
    api.route('/image/codex/logout', accountAction(async () => ({ ok: true, ...auth.logout() })))

    // 她的画作：面板底下的图库（直接读存图目录，可以单张删、开文件夹）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())

    // ---------- 画图任务：提交即返回，画完再推回会话 ----------
    const jobs = new Map() // id → { id, chatId, prompt, status, startedAt, error }
    let seq = 0
    const MAX_PER_CHAT = 2 // 同一个聊天里同时最多排两张，多了直接拒绝，免得刷屏

    function runningIn(chatId) {
      return [...jobs.values()].filter((j) => j.chatId === chatId && j.status === 'drawing').length
    }

    async function runDraw(id, chat, { prompt, shape, reference }) {
      const job = jobs.get(id)
      try {
        const buf = await gen.generate(String(prompt || ''), { shape, image: reference })
        const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        if (!sent) throw new Error('没发到 QQ（检查试运行和网关）')
        const saved = savePainting(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        const index = saved ? rememberPainting(chat.chatId, saved) : 0
        if (job) job.status = 'done'
        try {
          memory.addEvent?.({
            text: reference ? `参考了一张图画了：${String(prompt).slice(0, 120)}（提示词不一定等于实际画面）` : `按提示词画了一张图（不一定等于实际画面）：${String(prompt).slice(0, 120)}`,
            about: chat.kind === 'private' ? chat.userId : '',
            tags: ['画画'],
            importance: 0.4,
          })
        } catch (error) { api.log.warn('生图已发送，但经历没记下来：', error.message) }
        // 画完了：把图交给模型看（能看时），再推回会话让她自己说一句。
        // 这一步发生在当前轮之后，不会和正在跑的那一轮抢队列。
        const visual = (await hub.canSeeImages(chat)) === true
        const seeOwn = api.config().imageGen.seeOwn !== false
        let img = null
        if (visual && seeOwn) {
          img = await imageToolBlock(api.dsh, buf, { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath })
          if (!img) api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
        }
        const note = `（图刚画好，已经发在聊天里了。提示词是：${String(prompt).slice(0, 120)}${index ? `；画作编号 #${index}` : ''}。`
          + (img && saved ? `\n已保存到本机：${saved}（要收录表情包、存素材时可以用这个路径）` : '')
          + `${img ? '你看一眼' : '你看不到这张图'}，用你自己的口气跟主人说一句。）`
        await hub.pushToSession(chat, img ? [img, { type: 'text', text: note }] : [{ type: 'text', text: note }], '')
      } catch (error) {
        if (job) { job.status = 'failed'; job.error = error.message }
        api.log.warn(`生图 #${id} 失败：`, error.message)
        await hub.sendText(chat.chatId, `画 #${id} 没成：${error.message}`).catch(() => {})
      }
    }

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '提交一次画图任务：图会自动画好、发到当前 QQ 聊天里，画完会回来告诉你。提交后先跟主人说一声你在画，不用等图。prompt 详细描述画面；可以用 image 参考当前聊天最近收到的图（last）、引用消息里的图（quote）或自己画作的文件名来改画；shape 可按用途选择方图、竖图、横图或宽幅；不填就沿用面板默认构图 / 图片尺寸。',
      properties: {
        prompt: str('画面描述'),
        image: str('可选参考图：last = 当前聊天最近收到的一张图；quote = 当前聊天引用消息里的图；或图库中的画作文件名。禁止本地路径、网址'),
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide'], description: 'square 方图 1:1；portrait 竖图 2:3；landscape 横图 3:2；wide 宽幅 16:9。可不填' },
      },
      required: ['prompt'],
      execute: async ({ prompt, shape, image }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        if (image && api.config().imageGen.img2img === false) return { ok: false, message: '参考图功能已关闭' }
        // 参考图在提交前就解析：路径/网址这类非法输入要当场拒绝，别拖到后台才失败
        let reference
        try { reference = await resolveDrawImage(image, { hub, chat }) } catch (error) { return { ok: false, message: error.message } }
        const running = runningIn(chat.chatId)
        if (running >= MAX_PER_CHAT) return { ok: false, message: `手上还有 ${running} 张没画完，等这两张出来再说` }
        const id = ++seq
        jobs.set(id, { id, chatId: chat.chatId, prompt: String(prompt || ''), status: 'drawing', startedAt: Date.now() })
        void runDraw(id, chat, { prompt, shape, reference })
        return { ok: true, message: `画图任务 #${id} 已提交，画好会自动发到聊天里，到时候我再跟你说。先跟主人说一声你在画。` }
      },
    }) : []))
    return gen
  },
}
