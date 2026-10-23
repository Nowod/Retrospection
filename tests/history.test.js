import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_MS, MAX_RECORDS, recordUsage, rankRecords, deleteRecord,
  normalizeHistory, mergeHistories, normalizeSettings, enabledFor
} from "../extension/history.js";

const now = Date.UTC(2026, 9, 23, 8);

test("七天统计采用滚动 168 小时，边界过期，未来时间不计入", () => {
  const history = { records: [{ value: "复盘", lastUsed: now, events: [now - WINDOW_MS - 1, now - WINDOW_MS, now - WINDOW_MS + 1, now, now + 1] }] };
  assert.equal(rankRecords(history, now)[0].count, 2);
});

test("近七天频次优先，同频按最后输入时间排列；旧记录仍以零次保留", () => {
  const history = { records: [
    { value: "旧内容", lastUsed: now - WINDOW_MS * 2, events: [now - WINDOW_MS * 2] },
    { value: "最近", lastUsed: now, events: [now] },
    { value: "常用", lastUsed: now - 20, events: [now - 30, now - 20] },
    { value: "稍早", lastUsed: now - 5, events: [now - 5] }
  ] };
  assert.deepEqual(rankRecords(history, now).map(({ value, count }) => [value, count]), [["常用", 2], ["最近", 1], ["稍早", 1], ["旧内容", 0]]);
});

test("保存与回填按完整内容去重，保留空格、换行、大小写且不改写旧数据", () => {
  const first = recordUsage(null, "  一行\nTwo  ", now - 1);
  const snapshot = structuredClone(first);
  const second = recordUsage(first, "  一行\nTwo  ", now);
  assert.deepEqual(first, snapshot);
  assert.equal(second.records.length, 1);
  assert.equal(rankRecords(second, now)[0].count, 2);
  assert.equal(rankRecords(second, now)[0].value, "  一行\nTwo  ");
});

test("删除只影响指定内容，重新输入该内容从一次开始", () => {
  let history = recordUsage(null, "甲", now - 2);
  history = recordUsage(history, "乙", now - 1);
  const deleted = deleteRecord(history, "甲", now);
  assert.deepEqual(rankRecords(deleted, now).map(item => item.value), ["乙"]);
  const recreated = recordUsage(deleted, "甲", now);
  assert.equal(rankRecords(recreated, now).find(item => item.value === "甲").count, 1);
  assert.equal(history.records.length, 2);
});

test("拒绝空白与超长输入，合法内容恰好 4000 字可保存", () => {
  for (const value of ["", " \n\t", null, 3, "x".repeat(4001)]) assert.throws(() => recordUsage(null, value, now));
  assert.equal(recordUsage(null, "x".repeat(4000), now).records[0].value.length, 4000);
});

test("每个字段保留最近使用的 100 个不同内容，常用内容再次使用不会挤占新位置", () => {
  let history;
  for (let i = 0; i < MAX_RECORDS + 10; i++) history = recordUsage(history, String(i), now + i);
  assert.equal(history.records.length, MAX_RECORDS);
  assert.ok(!history.records.some(item => item.value === "0"));
  history = recordUsage(history, "20", now + 200);
  assert.equal(history.records.length, MAX_RECORDS);
  assert.equal(history.records[0].value, "20");
});

test("旧数据或损坏的数据可安全读取，不会渲染对象或重复记录", () => {
  const history = { records: [null, {}, { value: "" }, { value: { html: true } },
    { value: "正确", events: [null, "now", NaN, now], lastUsed: now },
    { value: "正确", events: [], lastUsed: now - 1 }] };
  assert.equal(normalizeHistory(history, now).records.length, 1);
  assert.equal(rankRecords(history, now)[0].count, 1);
  assert.deepEqual(normalizeHistory(null, now), { version: 1, records: [] });
});

test("全局与站点暂停彼此独立，损坏设置恢复默认值", () => {
  assert.equal(enabledFor(null, "https://example.com"), true);
  assert.equal(enabledFor({ enabled: false }, "https://example.com"), false);
  const config = normalizeSettings({ enabled: true, disabledOrigins: ["https://a.test", "https://a.test", null, 1] });
  assert.equal(enabledFor(config, "https://a.test"), false);
  assert.equal(enabledFor(config, "https://b.test"), true);
  assert.deepEqual(config.disabledOrigins, ["https://a.test"]);
});

test("合并历史累加同毫秒的真实使用，过滤过期事件且不修改来源", () => {
  const first = { records: [{ value: "共享", events: [now - WINDOW_MS, now], lastUsed: now }] };
  const second = { records: [{ value: "共享", events: [now], lastUsed: now }] };
  const snapshot = structuredClone([first, second]);
  const merged = mergeHistories([first, null, second], now);
  assert.deepEqual(rankRecords(merged, now).map(({ value, count }) => [value, count]), [["共享", 2]]);
  assert.deepEqual([first, second], snapshot);
});

test("合并多个旧分组仍按最近使用保留 100 条，重复内容不占新位置", () => {
  const groups = [0, 50].map(offset => ({ records: Array.from({ length: 100 }, (_, index) => ({
    value: String(index + offset), events: [now - 200 + index + offset], lastUsed: now - 200 + index + offset
  })) }));
  const merged = mergeHistories(groups, now);
  assert.equal(merged.records.length, 100);
  assert.deepEqual(merged.records.map(item => Number(item.value)), Array.from({ length: 100 }, (_, index) => 149 - index));
  assert.equal(rankRecords(merged, now).find(item => item.value === "75").count, 2);
});

test("同毫秒连续录入超过容量时，新内容保留且旧组不被原地改写", () => {
  let history;
  for (let i = 0; i < 120; i++) history = recordUsage(history, `内容 ${i}`, now);
  const before = structuredClone(history);
  const next = recordUsage(history, "最新输入", now);
  assert.equal(next.records.length, MAX_RECORDS);
  assert.equal(next.records[0].value, "最新输入");
  assert.deepEqual(history, before);
});
