#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { CookieJar } from 'tough-cookie'
import { HttpsProxyAgent } from 'hpagent'
// @ts-expect-error - html-to-text v10 未自带类型声明
import { convert } from 'html-to-text'
import { execFile } from 'node:child_process'
import got from 'got'
import { lint } from 'markdownlint/promise'
import { parse } from 'node-html-parser'
import path from 'node:path'
import { promisify } from 'node:util'

type HtmlElement = ReturnType<typeof parse>

const WORK_URL = 'https://archiveofourown.org/works/577310'
const WORK_VIEW_URL = `${WORK_URL}?view_adult=true&view_full_work=true`
// AO3 维护期间回退到固定存档快照（2021-09-25），保证抓取结果可复现
const WAYBACK_TIMESTAMP = '20210925115244'
const OUTPUT_DIR = 'original'
// 作者在第 13 章前注明两卷的非正式副标题：“Volume I ... 'In' ... Volume II, 'Out'”
// eslint-disable-next-line eslint/id-length -- 键为罗马数字本身，单字符无法改名
const VOLUME_TITLES: Record<string, string> = { I: 'In', II: 'Out' }

const execFileAsync = promisify(execFile)

interface CliOptions {
  fromFile?: string
  dumpHtml?: string
  wayback?: string
  force: boolean
}

/** 参数约定：默认自动（AO3 → Wayback 回退）；--wayback [YYYYMMDDhhmmss] 强制存档；
 *  --from-file <html> 离线解析；--dump-html <path> 只抓取存档不写 original/；--force 忽略增量检查 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { force: false }
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]
    if (arg === '--from-file') {
      options.fromFile = argv[++at]
    } else if (arg === '--dump-html') {
      options.dumpHtml = argv[++at]
    } else if (arg === '--wayback') {
      const next = argv[at + 1]
      if (next && /^\d{14}$/.test(next)) {
        options.wayback = next
        at++
      } else {
        options.wayback = WAYBACK_TIMESTAMP
      }
    } else if (arg === '--force') {
      options.force = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

// got 不读代理环境变量，这里手动接入；NO_PROXY 命中时保持直连
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
const noProxyList = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').toLowerCase()
const targetHost = new URL(WORK_URL).hostname
const noProxyHit = noProxyList.split(',').some((it) => {
  const pattern = it.trim()
  return (
    pattern === '*' || targetHost === pattern || targetHost.endsWith(pattern.startsWith('.') ? pattern : `.${pattern}`)
  )
})
const activeProxy = proxyUrl && !noProxyHit ? proxyUrl : undefined

const cookieJar = new CookieJar()
const http = got.extend({
  cookieJar,
  // hpagent 的 CONNECT 隧道按 HTTP/1.1 转发，h2 协商留给直连场景
  http2: !activeProxy,
  retry: {
    limit: 2,
    statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524, 525],
    backoffLimit: 5000,
  },
  timeout: { request: 300_000 },
  headers: {
    'accept-language': 'en-US,en;q=0.7',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  ...(activeProxy && { agent: { https: new HttpsProxyAgent({ proxy: activeProxy }) } }),
})
if (activeProxy) {
  console.log('Proxy enabled:', activeProxy)
}

function waybackUrl(timestamp: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${WORK_VIEW_URL}`
}

/** 快照时间戳为 UTC，用作 Wayback 源的“远端更新时间” */
function waybackDate(timestamp: string): Date {
  const year = Number(timestamp.slice(0, 4))
  const month = Number(timestamp.slice(4, 6)) - 1
  const day = Number(timestamp.slice(6, 8))
  const hour = Number(timestamp.slice(8, 10))
  const minute = Number(timestamp.slice(10, 12))
  const second = Number(timestamp.slice(12, 14))
  return new Date(Date.UTC(year, month, day, hour, minute, second))
}

/** 从作品页的下载按钮取 updated_at：AO3 只在正文有改动时更新它，比章节发布日期可靠 */
async function getDownloadInfo(): Promise<{ downloadLink: URL; updatedAt: Date }> {
  const html = await http.get(WORK_URL, { headers: { accept: 'text/html' } }).text()
  const dom = parse(html)
  const link = dom
    .querySelectorAll('a')
    .find((it) => /\/downloads\/\d+\/[^/?#]+?\.html/i.test(it.getAttribute('href') ?? ''))
  const href = link?.getAttribute('href')
  if (!href) {
    throw new Error(`Download link not found on ${WORK_URL}`)
  }
  const downloadLink = new URL(href, WORK_URL)
  const param = downloadLink.searchParams.get('updated_at')
  if (!param?.match(/^\d+$/)) {
    throw new Error(`Missing 'updated_at' in download url: ${downloadLink.href}`)
  }
  return { downloadLink, updatedAt: new Date(Number(param) * 1000) }
}

async function fetchAo3Work(): Promise<string> {
  return http.get(WORK_VIEW_URL, { headers: { accept: 'text/html', referer: WORK_URL } }).text()
}

async function fetchWayback(timestamp: string): Promise<string> {
  return http.get(waybackUrl(timestamp), { headers: { accept: 'text/html' } }).text()
}

interface ParsedChapter {
  no: number
  title: string
  body: string
  notes?: string
  endNotes?: string
}

interface ParsedVolume {
  roman: string
  title: string
  chapters: ParsedChapter[]
}

interface ParsedSource {
  title: string
  author: string
  summary: string
  volumes: ParsedVolume[]
}

const CHAPTER_TITLE = /^Chapter\s+(?<no>\d+):\s*(?:\(Volume\s+(?<vol>[IVXLC]+)\)\s*)?(?<title>.+)$/
const EMPTY_HINT = /^\(See the end of the chapter for\s+notes\.\)$/

function cleanInlineHtml(html: string): string {
  // 作者手写 HTML 常见 <em> 文本 </em> 内边距，markdown 强调语法不容忍内侧空格；空 <em></em> 会产出孤立 **
  return html
    .replace(/<(?<tag>em|i|strong|b)>\s+/g, '<$<tag>>')
    .replace(/\s+<\/(?<tag>em|i|strong|b)>/g, '</$<tag>>')
    .replace(/<(?<tag>em|i|strong|b)><\/\k<tag>>/g, '')
}

function convertHtml(html: string): string {
  return convert(cleanInlineHtml(html), {
    wordwrap: false,
    formatters: {
      // 作者内嵌的同人图还原为 markdown 外链；相对地址按作品页 URL 解析兜底
      imageLink: (
        elem: { attribs: Record<string, string | undefined> },
        _walk: unknown,
        builder: { addInline: (text: string) => void },
      ) => {
        const { src } = elem.attribs
        if (!src) {
          return
        }
        const alt = elem.attribs.alt ?? ''
        builder.addInline(`![${alt}](${new URL(src, WORK_URL).href})`)
      },
    },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'imageLink' },
      { selector: 'hr', options: { length: 3 } },
      { selector: 'ul', options: { itemPrefix: '- ' } },
      { selector: 'em', format: 'inlineSurround', options: { prefix: '*', suffix: '*' } },
      { selector: 'i', format: 'inlineSurround', options: { prefix: '*', suffix: '*' } },
      { selector: 'strong', format: 'inlineSurround', options: { prefix: '**', suffix: '**' } },
      { selector: 'b', format: 'inlineSurround', options: { prefix: '**', suffix: '**' } },
      { selector: 'del', format: 'inlineSurround', options: { prefix: '~~', suffix: '~~' } },
      { selector: 's', format: 'inlineSurround', options: { prefix: '~~', suffix: '~~' } },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
      { selector: 'h5', options: { uppercase: false } },
      { selector: 'h6', options: { uppercase: false } },
    ],
  })
}

/** 行尾/整行空白清零（含 U+00A0），收紧连续空行，保证 markdownlint 与 diff 稳定 */
function normalizeMarkdown(text: string): string {
  return text
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

/** AO3 页面 UI（landmark 标题）与作者排版留下的空强调标签（<em>\n<em></em>\n</em>）都不属于正文；
 *  空标签会转换出孤立的 ** 行，写盘前统一在 DOM 上剔除 */
function cleanDom(element: HtmlElement): void {
  for (const landmark of element.querySelectorAll('.landmark')) {
    landmark.remove()
  }
  for (const emphasis of element.querySelectorAll('em, i, strong, b')) {
    if (emphasis.text.trim() === '') {
      emphasis.remove()
    }
  }
}

function elementHtml(element: HtmlElement): string {
  cleanDom(element)
  return element.innerHTML
}

/** 注释块：有 blockquote.userstuff 时取内容，否则去掉“Notes:”标签取其余部分；
 *  仅含“See the end of the chapter for notes”的占位注释整块丢弃 */
function extractNote(note: HtmlElement | undefined): string | undefined {
  if (!note) {
    return undefined
  }
  const content = note.querySelector('blockquote.userstuff')
  if (content) {
    cleanDom(content)
    const text = normalizeMarkdown(convertHtml(content.innerHTML))
    return text && !EMPTY_HINT.test(content.text.trim()) ? text : undefined
  }
  for (const heading of note.querySelectorAll('h3')) {
    heading.remove()
  }
  cleanDom(note)
  const text = normalizeMarkdown(convertHtml(note.innerHTML))
  return text && !EMPTY_HINT.test(text) ? text : undefined
}

function parseChapter(chapterEl: HtmlElement, index: number): ParsedChapter {
  const heading = (chapterEl.querySelector('div.chapter.preface h3.title')?.text ?? '').replace(/\s+/g, ' ').trim()
  const match = CHAPTER_TITLE.exec(heading)
  const bodyEl = chapterEl.querySelector('div.userstuff.module')
  if (!bodyEl) {
    throw new Error(`Chapter body not found in: ${heading}`)
  }
  const notes = chapterEl.querySelectorAll('div.notes')
  const beginNote = notes.find((it) => !/\bend\b/.test(it.getAttribute('class') ?? ''))
  const endNote = notes.find((it) => /\bend\b/.test(it.getAttribute('class') ?? ''))
  return {
    no: Number(match?.groups?.no ?? index + 1),
    title: (match?.groups?.title ?? heading).trim(),
    body: normalizeMarkdown(convertHtml(elementHtml(bodyEl))),
    notes: extractNote(beginNote),
    endNotes: extractNote(endNote),
  }
}

function parseWork(html: string): ParsedSource {
  const dom = parse(html)
  const title = dom.querySelector('h2.title')?.text.trim()
  const author = dom.querySelector('h3.byline a')?.text.trim()
  if (!title || !author) {
    throw new Error('Not a work page: title/byline missing (AO3 may be showing an adult-content gate)')
  }
  const summaryEl = dom.querySelector('div.summary blockquote.userstuff')
  if (summaryEl) {
    cleanDom(summaryEl)
  }
  const summary = summaryEl ? normalizeMarkdown(convertHtml(summaryEl.innerHTML)) : ''

  const chapterEls = dom.querySelectorAll('div.chapter[id]')
  if (chapterEls.length === 0) {
    throw new Error('No chapters found in work page')
  }
  const volumes = new Map<string, ParsedVolume>()
  let currentVolume = 'I'
  for (const [index, chapterEl] of chapterEls.entries()) {
    const chapter = parseChapter(chapterEl, index)
    const heading = (chapterEl.querySelector('div.chapter.preface h3.title')?.text ?? '').replace(/\s+/g, ' ').trim()
    const volume = CHAPTER_TITLE.exec(heading)?.groups?.vol ?? currentVolume
    currentVolume = volume
    let parsedVolume = volumes.get(volume)
    if (!parsedVolume) {
      parsedVolume = { roman: volume, title: VOLUME_TITLES[volume] ?? volume, chapters: [] }
      volumes.set(volume, parsedVolume)
    }
    parsedVolume.chapters.push(chapter)
  }
  return { title, author, summary, volumes: [...volumes.values()] }
}

function romanToInt(roman: string): number {
  // eslint-disable-next-line eslint/id-length -- 键为罗马数字本身，单字符无法改名
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 }
  let result = 0
  for (let at = 0; at < roman.length; at++) {
    const cur = values[roman[at]] ?? 0
    const next = values[roman[at + 1]] ?? 0
    result += cur < next ? -cur : cur
  }
  return result
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

/** git autocrlf 检出的工作树是 CRLF：与产物比对前归一，避免本地运行时全树误报 updated */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

interface WriteStats {
  created: string[]
  updated: string[]
  removed: string[]
  unchanged: number
}

/** 对比现有 original/ 树做 upsert + 孤儿清理。文件身份 = 全局章编号，
 *  slug 仅在文件首次创建时从当时标题快照，此后标题变化只更新内容（git diff 稳定、URL 不抖动） */
async function writeOriginal(parsed: ParsedSource, sourceLabel: string): Promise<WriteStats> {
  const stats: WriteStats = { created: [], updated: [], removed: [], unchanged: 0 }
  const root = path.resolve(OUTPUT_DIR)
  await mkdir(root, { recursive: true })

  const existing = new Map<string, string>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = await readFile(path.join(root, entry.name), 'utf8')
      existing.set(entry.name, normalizeEol(file))
    } else if (entry.isDirectory()) {
      for (const name of await readdir(path.join(root, entry.name))) {
        if (name.endsWith('.md')) {
          const rel = `${entry.name}/${name}`
          const nested = await readFile(path.join(root, rel), 'utf8')
          existing.set(rel, normalizeEol(nested))
        }
      }
    }
  }

  const expected = new Map<string, string>()
  const home = `# ${parsed.title}\n\nby ${parsed.author}\n\n${blockquote(parsed.summary)}\n\n> Autogenerated by scripts/update-source.ts - DO NOT EDIT!\n> Content retrieved from ${WORK_URL}\n> Source: ${sourceLabel}\n> The Chinese translation is pending; books/ currently holds only the volume skeleton.\n`
  expected.set('readme.md', home)
  for (const volume of parsed.volumes) {
    const dir = String(romanToInt(volume.roman)).padStart(2, '0')
    expected.set(`${dir}/readme.md`, `# Volume ${volume.roman}: ${volume.title}\n`)
    for (const chapter of volume.chapters) {
      const prefix = `${String(chapter.no).padStart(3, '0')}-`
      const prev = [...existing.keys()].find((rel) => rel.startsWith(`${dir}/${prefix}`))
      const name = prev ? prev.slice(dir.length + 1) : `${prefix}${slugify(chapter.title)}.md`
      const extras = [
        chapter.notes && `## Chapter Notes\n\n${chapter.notes}`,
        chapter.body,
        chapter.endNotes && `## Chapter End Notes\n\n${chapter.endNotes}`,
      ]
        .filter(Boolean)
        .join('\n\n')
      expected.set(`${dir}/${name}`, `# Chapter ${chapter.no}: ${chapter.title}\n\n${extras}\n`)
    }
  }

  for (const [rel, content] of expected) {
    const prev = existing.get(rel)
    if (prev === content) {
      stats.unchanged++
    } else {
      const abs = path.join(root, rel)
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content)
      ;(prev === undefined ? stats.created : stats.updated).push(rel)
    }
  }
  for (const rel of existing.keys()) {
    if (!expected.has(rel)) {
      await rm(path.join(root, rel))
      stats.removed.push(rel)
    }
  }
  return stats
}

// 切分后每文件仅一个 H1；关闭项均为转换器产物或作者排版风格。
// MD026 额外关闭：作者章节标题本身以 ?/!/./… 结尾（如“This is a joke, right?”）
const lintConfig = {
  default: true,
  MD013: false,
  MD026: false,
  MD027: false,
  MD028: false,
  MD034: false,
  MD036: false,
  MD007: false,
  MD045: false,
}

async function lintOriginal(): Promise<void> {
  const root = path.resolve(OUTPUT_DIR)
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.name.endsWith('.md')) {
        files[path.relative(root, abs).replaceAll('\\', '/')] = await readFile(abs, 'utf8')
      }
    }
  }
  await walk(root)

  const results = await lint({ strings: files, config: lintConfig })
  let problems = 0
  for (const [file, errors] of Object.entries(results)) {
    for (const problem of errors) {
      problems++
      if (problems <= 20) {
        const detail = problem.errorDetail ? ` [${problem.errorDetail}]` : ''
        console.error(
          `  ${file}:${problem.lineNumber}: ${problem.ruleNames.join('/')} ${problem.ruleDescription}${detail}`,
        )
      }
    }
  }
  if (problems > 0) {
    console.error(`markdownlint failed with ${problems} problem(s)`)
    process.exit(1)
  }
  console.log('markdownlint passed')
}

function validate(parsed: ParsedSource): void {
  const chapters = parsed.volumes.flatMap((it) => it.chapters)
  const numbers = chapters.map((it) => it.no)
  if (parsed.volumes.length === 0 || chapters.length === 0) {
    throw new Error('Parsed work has no volumes/chapters')
  }
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`Duplicate chapter numbers: ${numbers.join(', ')}`)
  }
  for (let at = 1; at < numbers.length; at++) {
    if (numbers[at] !== numbers[at - 1] + 1) {
      throw new Error(`Chapter numbers are not contiguous: ${numbers.join(', ')}`)
    }
  }
}

async function run(html: string, sourceLabel: string): Promise<void> {
  const parsed = parseWork(html)
  validate(parsed)
  const stats = await writeOriginal(parsed, sourceLabel)
  console.log(
    `created ${stats.created.length}, updated ${stats.updated.length}, unchanged ${stats.unchanged}, removed ${stats.removed.length}`,
  )
  for (const rel of [...stats.created, ...stats.updated, ...stats.removed]) {
    console.log(`  ${rel}`)
  }
  await lintOriginal()
}

function isUpToDate(localLastUpdated: Date, remoteLastUpdated: Date, options: CliOptions): boolean {
  return !options.force && !options.dumpHtml && localLastUpdated >= remoteLastUpdated
}

/** 返回 undefined 表示远端未变化，无需写盘 */
async function acquire(
  options: CliOptions,
  localLastUpdated: Date,
): Promise<{ html: string; label: string } | undefined> {
  if (options.wayback) {
    if (isUpToDate(localLastUpdated, waybackDate(options.wayback), options)) {
      return undefined
    }
    const html = await fetchWayback(options.wayback)
    parseWork(html) // 快照可能被 Wayback 重定向到错误页，提前验证
    return { html, label: `Wayback Machine snapshot ${options.wayback}` }
  }

  try {
    const { updatedAt } = await getDownloadInfo()
    console.log('Remote AO3 version was updated at', updatedAt.toISOString())
    if (isUpToDate(localLastUpdated, updatedAt, options)) {
      return undefined
    }
    const html = await fetchAo3Work()
    parseWork(html) // 成人内容拦截页 / 维护页会在解析时抛错，触发 Wayback 回退
    return { html, label: 'AO3' }
  } catch (error) {
    console.warn(`AO3 unavailable (${error instanceof Error ? error.message : String(error)})`)
    if (isUpToDate(localLastUpdated, waybackDate(WAYBACK_TIMESTAMP), options)) {
      return undefined
    }
    console.warn(`Falling back to Wayback Machine snapshot ${WAYBACK_TIMESTAMP}`)
    const html = await fetchWayback(WAYBACK_TIMESTAMP)
    parseWork(html)
    return { html, label: `Wayback Machine snapshot ${WAYBACK_TIMESTAMP}` }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.fromFile) {
    const raw = normalizeEol(await readFile(options.fromFile, 'utf8'))
    await run(raw, `local file ${path.basename(options.fromFile)}`)
    console.log('Done,', OUTPUT_DIR)
    return
  }

  const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=format:%at', '--', OUTPUT_DIR]).catch(
    () => ({ stdout: '0' }), // original/ 尚未入 git 时（首次运行）视为极旧，必然触发抓取
  )
  const localLastUpdated = new Date(Number(stdout) * 1000)
  console.log('Local version was updated at', localLastUpdated.toISOString())

  const source = await acquire(options, localLastUpdated)
  if (!source) {
    console.log('Up to date')
    return
  }
  if (options.dumpHtml) {
    await mkdir(path.dirname(options.dumpHtml), { recursive: true })
    await writeFile(options.dumpHtml, source.html)
    console.log('Saved source HTML to', options.dumpHtml)
    return
  }

  await run(source.html, source.label)
  console.log('Done,', OUTPUT_DIR)
}

await main()
