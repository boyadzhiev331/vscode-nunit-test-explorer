import * as assert from 'assert';
import { extractTestsWithCategoryFromClass } from '../../tree/testDiscovery';

suite('tree/testDiscovery', () => {
  test('parses tests and category from fixture attribute', () => {
    const source = [
      '[TestFixture, Category("Smoke")]',
      'public class LoginTests',
      '{',
      '    [Test]',
      '    public void ValidLogin_Works() {}',
      '',
      '    [TestCase]',
      '    public async Task InvalidLogin_ShowsError() { await Task.CompletedTask; }',
      '}'
    ].join('\n');

    const tests = extractTestsWithCategoryFromClass(source, 'LoginTests.cs');
    assert.strictEqual(tests.length, 2);
    assert.strictEqual(tests[0].name, 'ValidLogin_Works');
    assert.strictEqual(tests[0].category, 'Smoke');
    assert.strictEqual(tests[1].name, 'InvalidLogin_ShowsError');
    assert.strictEqual(tests[1].category, 'Smoke');
  });

  test('defaults to Uncategorized when no category is present', () => {
    const source = [
      'public class MathTests',
      '{',
      '    [Test]',
      '    public void AddsNumbers() {}',
      '}'
    ].join('\n');

    const tests = extractTestsWithCategoryFromClass(source, 'MathTests.cs');
    assert.strictEqual(tests.length, 1);
    assert.strictEqual(tests[0].category, 'Uncategorized');
  });
});
