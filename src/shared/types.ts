// pr0Vault — Shared Types

export interface Tag {
  id: number;
  confidence: number;
  tag: string;
}

export interface Upload {
  id: number;
  image: string;
  thumb: string;
  flags: number;
  up: number;
  down: number;
  created: number;
  tags: Tag[];
  user: string;
  mark: number;
  promoted: number | null;
  thumbBlob?: Blob;
  fullBlob?: Blob;
  syncedAt: number;
}

export interface Comment {
  id: number;
  itemId: number;
  content: string;
  up: number;
  down: number;
  created: number;
  thumb: string;
}

export interface FilterBookmark {
  name: string;
  link: string;
  isDefault: boolean;
  syncedAt: number;
}

export interface Collection {
  id: number;
  name: string;
  keyword: string;
  isPublic: boolean;
  isDefault: boolean;
  isCurated: boolean;
  syncedAt: number;
}

export interface CollectionItem {
  collectionId: number;
  itemId: number;
  userId: number;
  user: string;
  created: number;
  image: string;
  thumb: string;
  flags: number;
  mark: number;
  up: number;
  down: number;
  tags: Tag[];
  thumbBlob?: Blob;
  syncedAt: number;
}

export interface Message {
  id: number;
  type: string;
  name: string;
  message: string;
  itemId?: number;
  created: number;
  read: boolean;
  syncedAt: number;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

export interface VaultStats {
  uploads: number;
  comments: number;
  filters: number;
  collections: number;
  messages: number;
  storageBytes: number;
  lastSync: number | null;
}

export function isVaultStats(v: unknown): v is VaultStats {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.uploads === "number" &&
    typeof s.comments === "number" &&
    typeof s.filters === "number" &&
    typeof s.collections === "number" &&
    typeof s.messages === "number" &&
    typeof s.storageBytes === "number" &&
    (s.lastSync === null || typeof s.lastSync === "number")
  );
}

export interface ExportData {
  exportDate: string;
  pr0VaultVersion: string;
  user: string;
  uploads: Upload[];
  comments: Comment[];
  filters: FilterBookmark[];
  collections: { collection: Collection; items: CollectionItem[] }[];
  messages: Message[];
}
