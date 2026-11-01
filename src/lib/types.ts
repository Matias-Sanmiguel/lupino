export type Attachment = { name: string; url: string };
export type Source = {
  id: string;
  title: string;
  subject: string;
  kind: string;
  originUrl?: string;
  author?: string;
  publishedAt?: string;
  updatedAt: string;
  status: string;
  revisionId: string;
  chunkCount: number;
  attachments: Attachment[];
};
export type Evidence = {
  id: string;
  sourceId: string;
  title: string;
  subject: string;
  locator: string;
  text: string;
  originUrl?: string;
};
export type SourceDetail = { source: Source; chunks: Evidence[] };
export type StudyEvent = {
  id: string;
  title: string;
  subject: string;
  kind: string;
  date: string;
  time: string | null;
  allDay: boolean;
  status: string;
  evidence: string;
  chunkId: string | null;
  sourceId: string | null;
  manuallyEdited: boolean;
  note: string;
};
export type Conversation = { id: string; title: string; updatedAt: string };
export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  provider: string;
  createdAt: string;
  evidence: Evidence[];
};
export type Snapshot = {
  sources: Source[];
  events: StudyEvent[];
  conversations: Conversation[];
  inboxErrors: string[];
};
export type Provider = {
  id: string;
  name: string;
  connected: boolean;
  detail: string;
  models: string[];
};
export type AgentEvent = {
  runId: string;
  type: string;
  delta?: string;
  text?: string;
  message?: string;
  evidence?: Evidence[];
  conversationId?: string;
};
