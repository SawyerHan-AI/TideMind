/**
 * parseJournalDate 单元测试(2026-06-24 第二轮审计 MEDIUM:无效日期范围校验)
 * classifier(init) / preprocessor(增量 isJournal) / queue(inferJournalDate) 三处共用此判据。
 */
import { describe, it, expect } from 'vitest';
import { parseJournalDate, extractJournalDateLoose } from '../../../src/integrations/logseq/journal-date.js';

describe('parseJournalDate', () => {
  it('解析三种标准日期格式', () => {
    expect(parseJournalDate('2022-02-17')).toBe('2022-02-17');
    expect(parseJournalDate('2022_02_17')).toBe('2022-02-17');
    expect(parseJournalDate('20220217')).toBe('2022-02-17');
  });

  it('接受边界有效值', () => {
    expect(parseJournalDate('2022-01-01')).toBe('2022-01-01');
    expect(parseJournalDate('2022-12-31')).toBe('2022-12-31');
  });

  it('拒绝月/日越界(防 NaN heat 僵尸节点 + 云端往返复活成热节点)', () => {
    expect(parseJournalDate('20229999')).toBeNull();   // 月99 日99
    expect(parseJournalDate('2022_13_45')).toBeNull();  // 月13 日45
    expect(parseJournalDate('2022-00-15')).toBeNull();  // 月0
    expect(parseJournalDate('2022-13-01')).toBeNull();  // 月13
    expect(parseJournalDate('2022-06-00')).toBeNull();  // 日0
    expect(parseJournalDate('2022-06-32')).toBeNull();  // 日32
  });

  it('拒绝非日期命名', () => {
    expect(parseJournalDate('我的笔记页')).toBeNull();
    expect(parseJournalDate('2022_2_17')).toBeNull();    // 单位数月/日不匹配 \d{2}
    expect(parseJournalDate('project-notes')).toBeNull();
    expect(parseJournalDate('2022')).toBeNull();
  });
});

describe('extractJournalDateLoose (journals/ 目录自定义命名宽松提取)', () => {
  it('从含额外 token 的文件名提取内嵌日期', () => {
    expect(extractJournalDateLoose('2022_02_17_Thursday')).toBe('2022-02-17');
    expect(extractJournalDateLoose('journal-2022-02-17-mon')).toBe('2022-02-17');
    expect(extractJournalDateLoose('2022_02_17')).toBe('2022-02-17'); // 标准也命中
  });

  it('范围校验:越界日期不提取(防 NaN heat,与第三轮 HIGH 对应)', () => {
    expect(extractJournalDateLoose('2022_99_99_custom')).toBeNull();
    expect(extractJournalDateLoose('2022_13_45_x')).toBeNull();
  });

  it('无内嵌日期返回 null', () => {
    expect(extractJournalDateLoose('我的自定义页面')).toBeNull();
    expect(extractJournalDateLoose('weekly-review')).toBeNull();
  });
});
