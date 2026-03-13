import { get as idbGet, set as idbSet, del as idbDel, createStore } from 'idb-keyval'

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc'])
const fontsDb = createStore('typsmthng-custom-fonts', 'fonts')
const DIRECTORIES_KEY = 'font-directories'

export interface CustomFontDirectory {
  id: string
  name: string
  path: string
  fontCount: number
}

interface PersistedDirectory {
  meta: CustomFontDirectory
  handle: FileSystemDirectoryHandle
}

export const PREDEFINED_DIRECTORIES: { name: string; path: string }[] = [
  {
    name: 'Adobe Fonts (activated)',
    path: '~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.r',
  },
  {
    name: 'Adobe Fonts (syncing)',
    path: '~/Library/Application Support/Adobe/CoreSync/plugins/livetype/.w',
  },
  {
    name: 'Adobe User Owned Fonts',
    path: '~/Library/Application Support/Adobe/.User Owned Fonts/',
  },
]

function generateId(): string {
  return `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function fontDataKey(directoryId: string): string {
  return `font-data:${directoryId}`
}

async function scanDirectoryForFonts(
  handle: FileSystemDirectoryHandle,
): Promise<Uint8Array[]> {
  const fontData: Uint8Array[] = []

  async function walk(dir: FileSystemDirectoryHandle): Promise<void> {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') {
        const name = entry.name.toLowerCase()
        const ext = name.slice(name.lastIndexOf('.'))
        if (FONT_EXTENSIONS.has(ext)) {
          try {
            const file = await entry.getFile()
            fontData.push(new Uint8Array(await file.arrayBuffer()))
          } catch {
            // skip unreadable files
          }
        }
      } else if (entry.kind === 'directory') {
        try {
          await walk(entry)
        } catch {
          // skip inaccessible subdirectories
        }
      }
    }
  }

  await walk(handle)
  return fontData
}

async function getPersistedDirectories(): Promise<PersistedDirectory[]> {
  try {
    return (await idbGet<PersistedDirectory[]>(DIRECTORIES_KEY, fontsDb)) ?? []
  } catch {
    return []
  }
}

async function setPersistedDirectories(dirs: PersistedDirectory[]): Promise<void> {
  await idbSet(DIRECTORIES_KEY, dirs, fontsDb)
}

export async function loadSavedDirectories(): Promise<CustomFontDirectory[]> {
  const dirs = await getPersistedDirectories()
  return dirs.map((d) => d.meta)
}

export async function addFontDirectory(): Promise<CustomFontDirectory | null> {
  if (!('showDirectoryPicker' in window)) {
    console.warn('File System Access API not supported')
    return null
  }

  let handle: FileSystemDirectoryHandle
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' })
  } catch {
    return null // user cancelled
  }

  const fontData = await scanDirectoryForFonts(handle)
  if (fontData.length === 0) {
    return null
  }

  const id = generateId()

  // Try to get a display path by resolving against a parent
  // The handle.name gives us the directory name
  const meta: CustomFontDirectory = {
    id,
    name: handle.name,
    path: handle.name,
    fontCount: fontData.length,
  }

  // Persist handle + metadata
  const dirs = await getPersistedDirectories()
  dirs.push({ meta, handle })
  await setPersistedDirectories(dirs)

  // Persist font data separately
  await idbSet(fontDataKey(id), fontData, fontsDb)

  return meta
}

export async function removeFontDirectory(id: string): Promise<void> {
  const dirs = await getPersistedDirectories()
  const filtered = dirs.filter((d) => d.meta.id !== id)
  await setPersistedDirectories(filtered)
  await idbDel(fontDataKey(id), fontsDb).catch(() => {})
}

export async function refreshFontDirectory(id: string): Promise<CustomFontDirectory | null> {
  const dirs = await getPersistedDirectories()
  const entry = dirs.find((d) => d.meta.id === id)
  if (!entry) return null

  try {
    const permission = await entry.handle.requestPermission({ mode: 'read' })
    if (permission !== 'granted') return null
  } catch {
    return null
  }

  const fontData = await scanDirectoryForFonts(entry.handle)
  entry.meta.fontCount = fontData.length
  await setPersistedDirectories(dirs)
  await idbSet(fontDataKey(id), fontData, fontsDb)

  return entry.meta
}

export async function loadAllCustomFontData(
  directories: CustomFontDirectory[],
): Promise<Uint8Array[]> {
  if (directories.length === 0) return []

  const allData: Uint8Array[] = []
  for (const dir of directories) {
    try {
      const data = await idbGet<Uint8Array[]>(fontDataKey(dir.id), fontsDb)
      if (data) {
        allData.push(...data)
      }
    } catch {
      // skip failed loads
    }
  }
  return allData
}
