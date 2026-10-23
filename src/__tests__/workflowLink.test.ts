import { originOf, withSession } from '../PremblyWorkflow';

jest.mock('react-native-webview', () => ({ WebView: () => null }));

describe('originOf', () => {
  it('keeps scheme, host and port only', () => {
    expect(originOf('http://localhost:3010/?session=x')).toBe('http://localhost:3010');
    expect(originOf('https://SDK-Live.Prembly.com/a/b#c')).toBe('https://sdk-live.prembly.com');
  });
  it('is empty for anything that is not http(s)', () => {
    expect(originOf('javascript:alert(1)')).toBe('');
    expect(originOf('not a url')).toBe('');
  });
});

describe('withSession', () => {
  it('adds the session and keeps the rest', () => {
    expect(withSession('http://localhost:3010/', 'wf_s1')).toBe('http://localhost:3010/?session=wf_s1');
    expect(withSession('https://h.example/p?a=1&session=old#x', 'wf_s1')).toBe(
      'https://h.example/p?a=1&session=wf_s1#x'
    );
  });
});
