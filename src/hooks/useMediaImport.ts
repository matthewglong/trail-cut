import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { ClipMetadata, Clip, Route } from '../types';
import { mergeClips } from '../utils/clips';

export type ProxyMap = Record<string, string | 'generating' | null>;
export type ThumbnailMap = Record<string, string>;

interface UseMediaImportParams {
  projectDir: string | null;
  setClips: React.Dispatch<React.SetStateAction<Clip[]>>;
  setSelectedClipId: React.Dispatch<React.SetStateAction<string | null>>;
  setRoute: React.Dispatch<React.SetStateAction<Route | null>>;
}

export function useMediaImport({ projectDir, setClips, setSelectedClipId, setRoute }: UseMediaImportParams) {
  const [proxies, setProxies] = useState<ProxyMap>({});
  const [thumbnails, setThumbnails] = useState<ThumbnailMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use a ref so async functions always see the latest projectDir
  const projectDirRef = useRef(projectDir);
  useEffect(() => {
    projectDirRef.current = projectDir;
  }, [projectDir]);

  const generateProxiesAndThumbnails = useCallback(async (clipList: Clip[], dir: string) => {
    for (const clip of clipList) {
      invoke<string>('generate_thumbnail', { sourcePath: clip.path, projectDir: dir })
        .then((thumbPath) => {
          setThumbnails((prev) => ({ ...prev, [clip.id]: thumbPath }));
        })
        .catch(() => {});

      setProxies((prev) => ({ ...prev, [clip.id]: 'generating' }));
      invoke<string>('generate_proxy', { sourcePath: clip.path, projectDir: dir })
        .then((proxyPath) => {
          setProxies((prev) => ({ ...prev, [clip.id]: proxyPath }));
        })
        .catch(() => {
          setProxies((prev) => ({ ...prev, [clip.id]: null }));
        });
    }
  }, []);

  async function importPaths(paths: string[]) {
    const dir = projectDirRef.current;
    if (!dir || paths.length === 0) return;
    try {
      setLoading(true);
      setError(null);

      const result = await invoke<ClipMetadata[]>('import_media', { paths });

      setClips((prev) => {
        const merged = mergeClips(prev, result);
        const newClips = merged.filter((c) => !prev.some((existing) => existing.path === c.path));
        if (newClips.length > 0) generateProxiesAndThumbnails(newClips, dir);
        return merged;
      });
      setSelectedClipId((prev) => prev ?? result[0]?.id ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleImportFiles() {
    if (!projectDirRef.current) return;
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [{ name: 'Video Files', extensions: ['mov', 'mp4', 'm4v'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await importPaths(paths as string[]);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImportFolder() {
    if (!projectDirRef.current) return;
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      await importPaths([selected as string]);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImportGpx() {
    const dir = projectDirRef.current;
    if (!dir) return;
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'GPS Route', extensions: ['gpx'] }],
      });
      if (!selected) return;

      setLoading(true);
      setError(null);

      const result = await invoke<Route>('parse_gpx', { filePath: selected, projectDir: dir });
      setRoute(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return {
    proxies,
    setProxies,
    thumbnails,
    setThumbnails,
    loading,
    error,
    setError,
    generateProxiesAndThumbnails,
    handleImportFiles,
    handleImportFolder,
    handleImportGpx,
  };
}
