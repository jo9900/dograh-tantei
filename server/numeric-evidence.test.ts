import { describe, expect, it } from 'vitest';
import { numericAudioConflicts, relevantNumericConflicts } from './numeric-evidence.js';

describe('numeric audio evidence conflicts', () => {
  it('detects the actual two-box Live text versus one-box recording mismatch', () => {
    expect(
      numericAudioConflicts('じゃあ、二箱お願いします。', 'じゃあ、一箱お願いします。'),
    ).toEqual([{ unit: '箱', liveValues: ['2'], recordedValues: ['1'] }]);
  });

  it('handles transcript fragment whitespace and normalizes full-width and kanji values', () => {
    expect(numericAudioConflicts('二 \n 箱お願いします。', '一\t箱お願いします。')).toHaveLength(1);
    expect(numericAudioConflicts('２ 箱、二\n十\n一個。', '二箱、21个。')).toEqual([]);
    expect(
      numericAudioConflicts('十二箱、一千二百三十四枚、零袋', '12 boxes, 1234枚、０袋'),
    ).toEqual([]);
  });

  it('normalizes English box units and compares integer sets in numeric order', () => {
    expect(numericAudioConflicts('10 boxes or 2 boxes', '1 box')).toEqual([
      { unit: '箱', liveValues: ['2', '10'], recordedValues: ['1'] },
    ]);
  });

  it('does not manufacture a conflict from missing numbers or different units', () => {
    expect(numericAudioConflicts('二箱お願いします。', 'お願いします。')).toEqual([]);
    expect(numericAudioConflicts('二箱お願いします。', '一袋お願いします。')).toEqual([]);
    expect(numericAudioConflicts('一名です。', '二人です。')).toEqual([]);
  });

  it('ignores repeated statements and changes when both sources have the same set', () => {
    expect(
      numericAudioConflicts('一箱、訂正して二箱。二箱です。', '2 boxes, earlier 1 box'),
    ).toEqual([]);
  });

  it.each(['个', '件', '台', '人', '名', '泊', '本', '枚', '袋'])(
    'checks explicit %s quantities',
    (unit) => {
      expect(numericAudioConflicts(`三${unit}`, `二${unit}`)).toEqual([
        { unit, liveValues: ['3'], recordedValues: ['2'] },
      ]);
    },
  );

  it('does not extract suffixes from unsupported decimal, signed, grouped or mixed values', () => {
    for (const text of ['1.5箱', '-2箱', '1,000箱', '2千箱', '十百箱', 'sku2boxes']) {
      expect(numericAudioConflicts(text, '一箱')).toEqual([]);
    }
  });

  it('restricts the downgrade to relevant unit or explicit quantity assertions', () => {
    const conflicts = numericAudioConflicts('二箱、三袋', '一箱、二袋');
    expect(relevantNumericConflicts('应确认两箱订单', conflicts)).toEqual([conflicts[0]]);
    expect(relevantNumericConflicts('Confirm the number of boxes', conflicts)).toEqual([
      conflicts[0],
    ]);
    for (const assertion of [
      '确认最终数量',
      '個数を確認する',
      '箱数を確認する',
      'Verify quantity',
      'Check count',
    ]) {
      expect(relevantNumericConflicts(assertion, conflicts)).toEqual(conflicts);
    }
    expect(relevantNumericConflicts('结束前礼貌道别', conflicts)).toEqual([]);
    expect(relevantNumericConflicts('Confirm the discount', conflicts)).toEqual([]);
    expect(relevantNumericConflicts('确认台数', conflicts)).toEqual([]);
  });
});
