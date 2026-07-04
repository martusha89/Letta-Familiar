export function getPackageRoot() {
  const url = new URL("../..", import.meta.url);
  const decoded = decodeURIComponent(url.pathname);
  // Strip leading slash before Windows drive letter ("/C:/..." -> "C:/...") and trailing slash.
  return decoded.replace(/^\/([A-Z]:)/, "$1").replace(/\/$/, "");
}

export function getNodeMajor() {
  return parseInt(process.versions.node.split(".")[0], 10);
}
