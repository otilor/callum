/** A file that was saved to the person's computer, kept so it can be saved again. */
export interface SavedFile {
  name: string;
  href: string;
  bytes: number;
}

export type SaveFile = (url: string, name: string) => Promise<SavedFile>;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetches a file from Callum and hands it to the browser as a download. */
export const saveFile: SaveFile = async (url, name) => {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin' });
  } catch {
    throw new Error("Callum can't be reached, so nothing was downloaded. Check that it is still running.");
  }
  if (!res.ok) throw new Error('The download did not work, so Callum kept everything as it was.');
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  return { name, href, bytes: blob.size };
};
