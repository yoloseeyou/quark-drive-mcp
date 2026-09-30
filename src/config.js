/**
 * 集中配置：把全部敏感信息与可调参数收敛到一处，统一从环境变量读取。
 *
 * 设计要点：
 *  - 敏感信息（夸克 Cookie、aria2 RPC 地址与密钥）只存在于环境变量中，绝不硬编码；
 *  - check 延迟到首次 getConfig()，缺少配置时抛出可读错误，而不是让进程启动即崩溃；
 *  - describeConfig() 提供脱敏快照，可安全地通过 config://server 资源暴露给客户端。
 */
import { envInt, envStr } from "./env.js";

/**
 * 默认伪装 UA，避免因 UA 异常触发夸克风控。
 *
 * ⚠️ 必须使用「夸克 PC 客户端」UA：普通浏览器 UA 调用 /1/clouddrive/file/download
 *    会被拒绝并返回 code=23018（download file size limit），实测 Chrome 120/131 均失败。
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4 Safari/537.36 Channel/395ed7d3";

/** 对敏感字符串做脱敏，仅保留首尾少量字符便于排查 */
function mask (value) {
  const text = String(value ?? "");
  if (text === "") return "";
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

let cached = null;

function buildConfig () {
  // ⚠️ 这里刻意不做必填校验：夸克 Cookie 只影响网盘相关能力。
  // 若在构建配置时就抛错，会导致 Tavily 等无关能力被一并阻断（校验放到 requireQuarkConfig）。
  return {
    quark: {
      cookie: envStr("QUARK_COOKIE"),
      baseUrl: envStr("QUARK_BASE_URL", "https://drive.quark.cn").replace(/\/+$/, ""),
      userAgent: envStr("QUARK_USER_AGENT", DEFAULT_USER_AGENT),
      referer: envStr("QUARK_REFERER", "https://pan.quark.cn/"),
      origin: envStr("QUARK_ORIGIN", "https://pan.quark.cn"),
      pr: envStr("QUARK_PR", "ucpro"),
      fr: envStr("QUARK_FR", "pc"),
      ucParamStr: envStr("UC_PARAM_STR", "dn")
    },
    aria2: {
      rpcUrl: envStr("ARIA2_RPC_URL", "http://127.0.0.1:6800/jsonrpc"),
      secret: envStr("ARIA2_RPC_SECRET"),
      downloadDir: envStr("ARIA2_DOWNLOAD_DIR")
    },
    cache: {
      ttlMs: envInt("DRIVE_CACHE_TTL_MS", 60 * 60 * 1000),
      maxEntries: envInt("DRIVE_CACHE_MAX_ENTRIES", 500)
    },
    tavily: {
      apiKey: envStr("TAVILY_API_KEY"),
      baseUrl: envStr("TAVILY_BASE_URL", "https://api.tavily.com").replace(/\/+$/, "")
    },
    runtime: {
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      cwd: process.cwd(),
      // 供 config://server 展示，不包含任何敏感值
      quarkCookieConfigured: envStr("QUARK_COOKIE") !== ""
    }
  };
}

/**
 * 获取配置单例（不做必填校验）。
 *
 * 各能力在使用点自行校验所需配置：网盘侧用 requireQuarkConfig()，
 * Tavily 侧在 tavily-client 中校验 API Key。这样「未配置某一项」不会拖垮其它能力。
 * @returns {{quark: object, aria2: object, cache: object, tavily: object, runtime: object}}
 */
export function getConfig () {
  if (cached === null) cached = buildConfig();
  return cached;
}

/**
 * 获取夸克网盘配置；未配置 Cookie 时抛出可读错误。
 * 由工具层捕获后转换为 isError 结果。
 * @returns {object} quark 配置
 */
export function requireQuarkConfig () {
  const { quark } = getConfig();

  if (quark.cookie === "") {
    throw new Error(
      "缺少必要环境变量 QUARK_COOKIE（夸克网盘登录 Cookie）。" +
      "请在项目根目录 .env 中配置，或由 MCP 客户端的 env 传入，可参考 .env.example。"
    );
  }

  return quark;
}

/**
 * 生成可安全展示的配置快照（敏感值脱敏）。
 * 任何情况下都不会抛异常，便于用于 config://server 资源。
 * `configured` 表示「夸克网盘侧是否可用」，Tavily 与 aria2 各自的配置状态单列。
 */
export function describeConfig () {
  const config = getConfig();
  const quarkConfigured = config.quark.cookie !== "";

  return {
    configured: quarkConfigured,
    quark: {
      baseUrl: config.quark.baseUrl,
      cookie: quarkConfigured ? `已配置（${config.quark.cookie.length} 字符，${mask(config.quark.cookie)}）` : "未配置",
      userAgent: config.quark.userAgent,
      referer: config.quark.referer,
      origin: config.quark.origin,
      pr: config.quark.pr,
      fr: config.quark.fr,
      ucParamStr: config.quark.ucParamStr
    },
    aria2: {
      rpcUrl: config.aria2.rpcUrl,
      secret: config.aria2.secret === "" ? "未配置（RPC 无鉴权）" : `已配置（${mask(config.aria2.secret)}）`,
      downloadDir: config.aria2.downloadDir === "" ? "（留空，使用 aria2 默认目录）" : config.aria2.downloadDir
    },
    cache: config.cache,
    tavily: {
      apiKey: config.tavily.apiKey === "" ? "未配置" : `已配置（${mask(config.tavily.apiKey)}）`,
      baseUrl: config.tavily.baseUrl
    },
    runtime: config.runtime
  };
}

/** 供日志使用：只输出脱敏后的关键配置，绝不打印 Cookie 明文 */
export function configSummaryForLog () {
  const described = describeConfig();
  const quarkState = described.configured ? described.quark.baseUrl : "未配置（仅网盘能力不可用）";
  return `quark=${quarkState} aria2=${described.aria2.rpcUrl} tavily=${described.tavily.apiKey} cacheTtl=${described.cache.ttlMs}ms`;
}
