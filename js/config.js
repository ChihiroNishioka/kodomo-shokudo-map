export async function loadAppConfig() {
  const configUrl = new URL("../data/config.json", import.meta.url);
  const response = await fetch(configUrl);
  if (!response.ok) {
    throw new Error("設定ファイルを読み込めませんでした");
  }
  const config = await response.json();
  const dataUrl = new URL(config.dataSource, window.location.href);
  const sourcesUrl = config.sourcesSummary
    ? new URL(config.sourcesSummary, window.location.href)
    : null;
  return { config, dataUrl, sourcesUrl };
}

export async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} を読み込めませんでした`);
  }
  return response.json();
}
