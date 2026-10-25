/**
 * 为"用 db:push 建库、从未记录迁移"的数据库补一条迁移基线。
 *
 * 背景：drizzle 的迁移器只读取 drizzle.__drizzle_migrations 里 created_at 最大的一行，
 * 然后执行 created_at 更大的迁移。生产库由 push 建表但记录表为空，于是 migrate 会从
 * 0000 重新执行并撞上已存在的枚举/表。
 *
 * 本脚本做的事：
 *   1. 校验 0000~0004 的产物确实已经存在（避免盲目基线把没建的东西标成已建）
 *   2. 写入一条 created_at = 0004 的记录
 *   3. 之后 `pnpm db:migrate` 只会执行 0005
 *
 * 用法：
 *   DATABASE_URL="<Neon 直连串>" node scripts/baseline-drizzle.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const BASELINE_TAG = "0004_video_generation_provider_backfill";
const SCHEMA = "drizzle";
const TABLE = "__drizzle_migrations";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ 缺少 DATABASE_URL，请先设置环境变量再运行。");
  process.exit(1);
}
if (/-pooler\./i.test(url)) {
  console.error("✗ 当前是 Neon 连接池地址（含 -pooler），DDL 会失败。请改用直连地址。");
  process.exit(1);
}

/** 0000~0004 应该已经产生的结果，缺任何一个都说明基线不安全 */
const PRECONDITIONS = [
  { label: "schema user_role", query: `select 1 from pg_type where typname = 'user_role'` },
  { label: "表 user", query: `select 1 from information_schema.tables where table_schema='public' and table_name='user'` },
  { label: "表 user_api_keys", query: `select 1 from information_schema.tables where table_schema='public' and table_name='user_api_keys'` },
  { label: "表 analysis_history", query: `select 1 from information_schema.tables where table_schema='public' and table_name='analysis_history'` },
  { label: "表 video_generation", query: `select 1 from information_schema.tables where table_schema='public' and table_name='video_generation'` },
  { label: "列 analysis_history.language", query: `select 1 from information_schema.columns where table_schema='public' and table_name='analysis_history' and column_name='language'` },
  { label: "列 video_generation.provider", query: `select 1 from information_schema.columns where table_schema='public' and table_name='video_generation' and column_name='provider'` },
];

function readBaseline() {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"));
  const entry = journal.entries.find((item) => item.tag === BASELINE_TAG);
  if (!entry) throw new Error(`_journal.json 里找不到 ${BASELINE_TAG}`);

  const content = readFileSync(join(MIGRATIONS_DIR, `${BASELINE_TAG}.sql`), "utf8");
  return {
    tag: BASELINE_TAG,
    when: entry.when,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 15 });

try {
  const baseline = readBaseline();
  console.log(`→ 基线目标：${baseline.tag}（created_at = ${baseline.when}）`);

  await sql.unsafe(`create schema if not exists "${SCHEMA}"`);
  await sql.unsafe(`
    create table if not exists ${SCHEMA}.${TABLE} (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);

  const existing = await sql.unsafe(
    `select hash, created_at from ${SCHEMA}.${TABLE} order by created_at desc limit 5`,
  );

  if (existing.length > 0) {
    const latest = existing[0];
    console.log(`• 记录表已有 ${existing.length} 条记录，最新 created_at = ${latest.created_at}`);
    if (Number(latest.created_at) >= Number(baseline.when)) {
      console.log("✓ 已经处于基线之后，无需处理。直接运行：pnpm db:migrate");
      process.exit(0);
    }
  }

  // 1) 校验前置产物
  const missing = [];
  for (const check of PRECONDITIONS) {
    const rows = await sql.unsafe(check.query);
    if (rows.length === 0) missing.push(check.label);
  }
  if (missing.length > 0) {
    console.error("✗ 以下对象不存在，说明 0000~0004 并未完整应用，拒绝写基线：");
    for (const item of missing) console.error(`   - ${item}`);
    console.error("  建议：改用 pnpm db:push 让 drizzle 对比 schema 后补全，再回来跑本脚本。");
    process.exit(1);
  }
  console.log(`✓ 前置对象校验通过（${PRECONDITIONS.length} 项）`);

  // 2) 写入基线
  await sql.unsafe(
    `insert into ${SCHEMA}.${TABLE} ("hash", "created_at") values ($1, $2)`,
    [baseline.hash, baseline.when],
  );
  console.log(`✓ 已写入基线记录：${baseline.hash.slice(0, 12)}…`);

  const after = await sql.unsafe(`select count(*)::int as count from ${SCHEMA}.${TABLE}`);
  console.log(`✓ 当前记录数：${after[0].count}`);
  console.log("\n下一步：pnpm db:migrate   （只会执行 0005_unknown_silver_fox）");
} catch (error) {
  console.error(`✗ 执行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
