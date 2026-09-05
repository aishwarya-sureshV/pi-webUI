import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  api,
  backendLabel,
  subscribeEvents,
  type ModelInfo,
  type ContextUsageReport,
  type QueuedMessage,
  type WorkspaceMatch,
  type RewindFilesResult,
  type ProviderUsage,
  type SlashCommand,
} from "../lib/api";
import { useStore, useTimeline, type ConversationTab } from "../lib/store";
import { DeployButton } from "./DeployButton";
import {
  contextualSessionTitle,
  isLocalCommandText,
} from "../lib/sessionTitle";
import {
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODELS,
  formatClaudeModelName,
} from "../lib/claudeModels";
import {
  isModelIdentityQuestion,
  runtimeModelAnswer,
} from "../lib/modelIdentity";
import {
  estimateContext,
  compactTokens,
  type ContextUsage,
} from "../lib/sessionMetrics";
import { exportFilename, timelineToMarkdown } from "../lib/exportSession";
import type { TimelineItem } from "../lib/timeline";
import { ToolCard } from "./ToolCard";
import { RichText } from "./RichText";
import {
  getToolDiff,
  type DiffLine,
  type ToolFileView,
} from "../lib/toolCards";
import { FileViewer } from "./FileViewer";
import { Trajectory } from "./Trajectory";
import { BackendLog } from "./BackendLog";
import { WorkspacePicker, type WorkspacePickerHandle } from "./WorkspacePicker";
import {
  WorkspaceExplorer,
  type WorkspacePlacement,
} from "./WorkspaceExplorer";
import { CopyButton } from "./CopyButton";
import { TodoTracker, TodoTranscript, extractTodos } from "./TodoTracker";
import { ChangesPanel } from "./ChangesPanel";
import { UsageSummary } from "./UsageDisplay";
import {
  ActiveRunIndicator,
  ToolActivitySummary,
  ToolDetailsRail,
  type ToolGroup,
} from "./ToolActivity";
import {
  IconArrowUp,
  IconChevronDown,
  IconCode,
  IconCommand,
  IconCube,
  IconDownload,
  IconFile,
  IconFolderPlus,
  IconFork,
  IconInfo,
  IconHistory,
  IconPencil,
  IconPlus,
  IconStop,
  IconUpload,
  FishLogo,
} from "./icons";

type ModelOption = { provider: string; id: string; label: string };
type AccessMode = "workspace-write" | "read-only";
type AgentMode = "standard" | "plan";
const USAGE_IDLE_REFRESH_INTERVAL_MS = 5 * 60_000 + 30_000;
const USAGE_RUNNING_REFRESH_INTERVAL_MS = 30_000;
type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  imageData?: string;
};

function isUsageShortcut(value: string): boolean {
  return /^\/(?:grok-cli-usage|grok-usage)$/i.test(value.trim());
}

/** Commands handled entirely in the UI (never sent to the backend). */
const LOCAL_COMMANDS: SlashCommand[] = [
  {
    name: "clear",
    description: "Wipe the slate and start a fresh session",
    source: "local",
  },
  {
    name: "compact",
    description: "Compress older history before a new phase of work",
    source: "local",
  },
  {
    name: "context",
    description: "See what is using the context window",
    source: "local",
  },
  {
    name: "cost",
    description: "Check spend and usage for the current model",
    source: "local",
  },
  {
    name: "diff",
    description: "Review every file change in one diff viewer",
    source: "local",
  },
  {
    name: "export",
    description: "Download this conversation as a Markdown transcript",
    source: "local",
  },
  {
    name: "fork",
    description: "Fork the latest reply into a side chat with its own worktree",
    source: "local",
  },
  {
    name: "goal",
    description:
      "Park a background goal with automatic check-ins (/goal off clears)",
    source: "local",
  },
  {
    name: "pull",
    description: "Pull the latest changes for this repository",
    source: "local",
  },
  {
    name: "push",
    description: "Push this repository to its remote",
    source: "local",
  },
  {
    name: "usage",
    description: "Check spend and usage for the current model",
    source: "local",
  },
];

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () =>
      resolve(String(reader.result ?? "").split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function Conversation({
  tab,
  split = false,
  paneIndex = 0,
  paneCount = 1,
  onClose,
  onSessionSplit,
}: {
  tab: ConversationTab;
  split?: boolean;
  paneIndex?: number;
  paneCount?: number;
  onClose?: () => void;
  onSessionSplit?: (key: string) => void;
}) {
  const timeline = useTimeline(tab.timeline)!;
  const {
    refreshSessions,
    setConversationSessionPath,
    setConversationWorkspace,
    setPreferredModel,
    setConversationLabel,
    workspaceReveal,
    openForkedConversation,
  } = useStore();
  const [draft, setDraft] = useState("");
  // The draft survives page reloads: keyed by conversation identity (the
  // session file once it exists, else a fresh-conversation slot per backend
  // + cwd). When the identity resolves in place (fresh chat gained its
  // session file, fork, session switch) the in-progress draft is carried
  // over rather than overwritten from storage.
  const draftKey = `pi-web.draft:${
    tab.sessionPath ?? `new:${tab.backend}:${tab.cwd}`
  }`;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const draftKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return;
    const isInitialLoad = draftKeyRef.current === null;
    draftKeyRef.current = draftKey;
    if (isInitialLoad) {
      setDraft(localStorage.getItem(draftKey) ?? "");
      return;
    }
    if (draftRef.current) localStorage.setItem(draftKey, draftRef.current);
    else localStorage.removeItem(draftKey);
  }, [draftKey]);
  useEffect(() => {
    if (draftKeyRef.current !== draftKey) return;
    if (draft) localStorage.setItem(draftKey, draft);
    else localStorage.removeItem(draftKey);
  }, [draft, draftKey]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [viewer, setViewer] = useState<ToolFileView | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [models, setModels] = useState<ModelInfo[]>(() =>
    tab.backend === "claude" ? CLAUDE_MODELS : [],
  );
  const [levels, setLevels] = useState<string[]>(() =>
    tab.backend === "claude" ? CLAUDE_EFFORT_LEVELS : [],
  );
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("workspace-write");
  const [agentMode, setAgentMode] = useState<AgentMode>("standard");
  const [toolRail, setToolRail] = useState<ToolGroup | null>(null);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // "@" file picker: the caret position is tracked because a mention is only
  // the token immediately before the caret, unlike "/" which owns the draft.
  const [caret, setCaret] = useState(0);
  const [mentionMatches, setMentionMatches] = useState<WorkspaceMatch[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Prompts lined up behind the running turn. Server-owned, so a refresh or a
  // second tab sees the same queue.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  /**
   * What Enter does while a turn is running. Queueing waits for the turn to
   * finish; steering pushes the message into the turn that is already going,
   * which is the only way to redirect work mid-flight. Cmd/Ctrl+Enter always
   * steers regardless, so the fast path never needs the menu.
   */
  const [midTurnMode, setMidTurnMode] = useState<"queue" | "steer">(() =>
    localStorage.getItem("pi-web.mid-turn") === "steer" ? "steer" : "queue",
  );
  const chooseMidTurnMode = (mode: "queue" | "steer") => {
    setMidTurnMode(mode);
    try {
      localStorage.setItem("pi-web.mid-turn", mode);
    } catch {
      /* private mode; the choice lasts this session only */
    }
  };
  // Set for one send by Cmd/Ctrl+Enter, then cleared.
  const steerOnceRef = useRef(false);
  const [conversationView, setConversationView] = useState<
    "chat" | "trajectory" | "backend"
  >("chat");
  const [sessionDetailsOpen, setSessionDetailsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceMounted, setWorkspaceMounted] = useState(false);
  const [workspacePlacement, setWorkspacePlacement] =
    useState<WorkspacePlacement>(() =>
      localStorage.getItem("pi-web.workspace-placement") === "full"
        ? "full"
        : "side",
    );
  const workspacePickerRef = useRef<WorkspacePickerHandle | null>(null);
  const [providerUsage, setProviderUsage] = useState<ProviderUsage | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const addDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const usageRequestRef = useRef<Promise<boolean> | null>(null);
  const usageRefreshPendingRef = useRef(false);
  const commandRequestRef = useRef<Promise<void> | null>(null);
  const modelMetadataRequestRef = useRef<Promise<void> | null>(null);
  const commandsLoadedRef = useRef(false);
  const modelMetadataLoadedRef = useRef(tab.backend === "claude");

  const state = timeline.state;

  const status = timeline.status;
  const streaming = status === "working" || state?.isStreaming === true;
  const firstUserItem = timeline.items.find(
    (item) =>
      item.kind === "user" &&
      !isLocalCommandText(item.kind === "user" ? item.text : ""),
  );
  const firstUserText =
    firstUserItem?.kind === "user" ? firstUserItem.text : undefined;
  const displayTitle = contextualSessionTitle(
    state?.sessionName || firstUserText || tab.label,
    tab.label,
  );
  const todos = extractTodos(timeline.items, { turnComplete: !streaming });
  // Claude Code can count the context for real; every other backend gets the
  // character-based estimate. Refreshed between turns, since that is when the
  // number actually moves and when the CLI is free to answer.
  const [exactContext, setExactContext] = useState<ContextUsageReport | null>(
    null,
  );
  const estimated = estimateContext(timeline.items, state);
  const context: ContextUsage = exactContext
    ? {
        estimatedTokens: exactContext.totalTokens,
        contextWindow: exactContext.maxTokens,
        percent: exactContext.percent,
        exact: true,
        autoCompactAt: exactContext.isAutoCompactEnabled
          ? exactContext.autoCompactThreshold
          : undefined,
        categories: exactContext.categories,
      }
    : estimated;
  const hasItems = timeline.items.length > 0;
  // Reasoning summaries are intentionally not rendered in the chat view. The
  // data still flows through the timeline (Trajectory tab, context estimates),
  // but the transcript stays clean; thinking activity surfaces as the
  // "is thinking" spinner while the agent streams.
  // Subagent calls render inside the Task card that spawned them, so they
  // must not also appear as siblings in the main transcript.
  const subagentChildren = new Map<
    string,
    Extract<TimelineItem, { kind: "tool" }>[]
  >();
  for (const item of timeline.items) {
    if (item.kind !== "tool" || !item.parentToolUseId) continue;
    const siblings = subagentChildren.get(item.parentToolUseId) ?? [];
    siblings.push(item);
    subagentChildren.set(item.parentToolUseId, siblings);
  }
  const visibleItems = timeline.items.filter(
    (item) =>
      item.kind !== "rationale" &&
      !(item.kind === "tool" && item.parentToolUseId) &&
      !(item.kind === "user" && isLocalCommandText(item.text)),
  );
  const liveNarration = visibleItems.at(-1);
  const showingLiveText = Boolean(
    liveNarration && liveNarration.kind === "assistant" && liveNarration.live,
  );
  const chatRows = buildChatRows(visibleItems, streaming);
  // TimelineRow is memoized; passing fresh inline closures here would bust the
  // memo on every tick. Route the calls through a ref so identities stay
  // stable while the closures always see the latest state.
  const rowHandlersRef = useRef({
    onFork: (_item: Extract<TimelineItem, { kind: "assistant" }>): void => {},
    onRewindFiles: async (
      _timestamp: number,
      _dryRun: boolean,
    ): Promise<RewindFilesResult> => ({}),
    onEditMessage: (_item: Extract<TimelineItem, { kind: "user" }>): void => {},
    onCancelEdit: (): void => {},
    onVersionChange: (
      _item: Extract<TimelineItem, { kind: "user" }>,
      _index: number,
    ): void => {},
  });
  rowHandlersRef.current = {
    onFork: (item) => void forkOutput(item),
    onRewindFiles: async (timestamp, dryRun) => {
      const result = await api.rewindFiles(tab.key, timestamp, dryRun, {
        cwd: tab.cwd,
        sessionPath: state?.sessionFile,
      });
      if (!result.ok)
        return { error: result.error ?? "The rewind could not be applied." };
      return result.data ?? {};
    },
    onEditMessage: (messageItem) => {
      setEditingMessageId(messageItem.id);
      setDraft(
        messageItem.versions?.[messageItem.versionIndex ?? 0]?.text ??
          messageItem.text,
      );
      window.setTimeout(() => {
        autoGrow();
        textareaRef.current?.focus();
      }, 0);
    },
    onCancelEdit: () => {
      setEditingMessageId(null);
      setDraft("");
    },
    onVersionChange: (messageItem, index) =>
      void selectUserVersion(messageItem, index),
  };
  const stableRowHandlers = useMemo(
    () => ({
      onEditMessage: (
        messageItem: Extract<TimelineItem, { kind: "user" }>,
      ): void => rowHandlersRef.current.onEditMessage(messageItem),
      onCancelEdit: (): void => rowHandlersRef.current.onCancelEdit(),
      onVersionChange: (
        messageItem: Extract<TimelineItem, { kind: "user" }>,
        index: number,
      ): void => rowHandlersRef.current.onVersionChange(messageItem, index),
      onFork: (item: Extract<TimelineItem, { kind: "assistant" }>): void =>
        rowHandlersRef.current.onFork(item),
      onRewindFiles: (
        timestamp: number,
        dryRun: boolean,
      ): Promise<RewindFilesResult> =>
        rowHandlersRef.current.onRewindFiles(timestamp, dryRun),
    }),
    [],
  );
  const responseActionIds = getResponseActionIds(visibleItems, streaming);
  // The model tag is noise when repeated under every reply — surface it only on
  // the most recent completed assistant response, and only once the whole
  // turn has settled: mid-execution the last completed block is just an
  // intermediate step, so tagging it reads like every block is tagged.
  const lastAssistantId = streaming
    ? undefined
    : [...visibleItems]
        .reverse()
        .find((item) => item.kind === "assistant" && !item.live)?.id;
  const runningShell = streaming
    ? [...timeline.items]
        .reverse()
        .find(
          (item): item is Extract<TimelineItem, { kind: "tool" }> =>
            item.kind === "tool" &&
            (item.name.toLowerCase() === "bash" ||
              item.execKind === "execute") &&
            item.status === "running",
        )
    : undefined;

  const loadModelMetadata = useCallback(() => {
    if (
      modelMetadataRequestRef.current ||
      status === "starting" ||
      status === "stopped"
    )
      return;
    const request = Promise.all([
      api.models(tab.key, tab.backend),
      api.thinkingLevels(tab.key, tab.backend),
    ])
      .then(([modelResult, levelResult]) => {
        if (
          modelResult.ok &&
          Array.isArray(modelResult.models) &&
          modelResult.models.length > 0
        )
          setModels(modelResult.models);
        if (
          levelResult.ok &&
          Array.isArray(levelResult.levels) &&
          levelResult.levels.length > 0
        )
          setLevels(levelResult.levels);
        if (modelResult.ok && levelResult.ok)
          modelMetadataLoadedRef.current = true;
      })
      .finally(() => {
        modelMetadataRequestRef.current = null;
      });
    modelMetadataRequestRef.current = request;
  }, [status, tab.backend, tab.key]);

  const loadCommands = useCallback(() => {
    if (
      commandsLoadedRef.current ||
      commandRequestRef.current ||
      status === "starting" ||
      status === "stopped"
    )
      return;
    const request = api
      .commands(tab.key, tab.backend)
      .then((result) => {
        if (result.ok && Array.isArray(result.commands)) {
          setCommands(result.commands);
          commandsLoadedRef.current = true;
        }
      })
      .finally(() => {
        commandRequestRef.current = null;
      });
    commandRequestRef.current = request;
  }, [status, tab.backend, tab.key]);

  const openWorkspace = useCallback(() => {
    setWorkspaceMounted(true);
    setWorkspaceOpen(true);
  }, []);

  useEffect(() => {
    if (workspaceReveal?.key === tab.key) openWorkspace();
  }, [openWorkspace, tab.key, workspaceReveal]);

  const chooseWorkspacePlacement = useCallback(
    (next: WorkspacePlacement) => {
      localStorage.setItem("pi-web.workspace-placement", next);
      setWorkspacePlacement(next);
      openWorkspace();
    },
    [openWorkspace],
  );

  const closeWorkspace = useCallback(() => setWorkspaceOpen(false), []);

  const toggleWorkspace = () => {
    setWorkspaceOpen((open) => {
      if (!open) setWorkspaceMounted(true);
      return !open;
    });
  };

  useEffect(() => {
    if (draft.startsWith("/") || commandMenuOpen) loadCommands();
  }, [commandMenuOpen, draft, loadCommands]);

  useEffect(() => {
    let cancelled = false;
    void api.backendLog(tab.key).then((result) => {
      if (!cancelled && result.ok && Array.isArray(result.entries))
        timeline.hydrateBackendLog(result.entries);
    });
    return () => {
      cancelled = true;
    };
  }, [tab.key, timeline]);

  const refreshUsage = useCallback(
    (force = false): Promise<boolean> => {
      if (usageRequestRef.current) return usageRequestRef.current;
      const request = api
        .usage(tab.key, tab.backend, force)
        .then((result) => {
          setProviderUsage(result.ok ? result.usage : null);
          return result.ok;
        })
        .catch(() => {
          setProviderUsage(null);
          return false;
        })
        .finally(() => {
          usageRequestRef.current = null;
        });
      usageRequestRef.current = request;
      return request;
    },
    [tab.backend, tab.key],
  );

  useEffect(() => {
    // Refresh once when the session loads. While the agent is working, poll every
    // 30s with a forced provider check so the composer usage stays current.
    if (status === "starting" || status === "stopped" || !state) return;
    let timer: number | undefined;
    let cancelled = false;
    const running = status === "working" || state.isStreaming === true;
    const interval = running
      ? USAGE_RUNNING_REFRESH_INTERVAL_MS
      : USAGE_IDLE_REFRESH_INTERVAL_MS;

    const schedule = () => {
      if (cancelled) return;
      if (!running && document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void refreshUsage(running).finally(schedule);
      }, interval);
    };
    const refreshOnVisible = () => {
      if (document.hidden && !running) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      const force = running || usageRefreshPendingRef.current;
      usageRefreshPendingRef.current = false;
      void refreshUsage(force).finally(schedule);
    };

    void refreshUsage(running).finally(schedule);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [
    refreshUsage,
    state?.isStreaming,
    state?.model?.id,
    state?.model?.provider,
    status,
  ]);

  useEffect(() => {
    setQueued(state?.queuedMessages ?? []);
  }, [state?.queuedMessages]);

  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.sessionKey !== tab.key || event.type !== "queue_updated")
          return;
        setQueued((event.queued as QueuedMessage[]) ?? []);
      }),
    [tab.key],
  );

  useEffect(() => {
    if (tab.backend !== "claude" || streaming) {
      if (tab.backend !== "claude") setExactContext(null);
      return;
    }
    let cancelled = false;
    void api
      .contextUsage(tab.key)
      .then((result) => {
        if (!cancelled)
          setExactContext(result.ok && result.data ? result.data : null);
      })
      .catch(() => {
        if (!cancelled) setExactContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tab.key, tab.backend, streaming, timeline.items.length]);

  useEffect(
    () =>
      subscribeEvents((event) => {
        if (event.sessionKey !== tab.key || event.type !== "agent_settled")
          return;
        if (document.hidden) {
          usageRefreshPendingRef.current = true;
          return;
        }
        void refreshUsage(true);
      }),
    [refreshUsage, tab.key],
  );

  useEffect(() => {
    setConversationLabel(tab.key, displayTitle);
  }, [displayTitle, setConversationLabel, tab.key]);

  useLayoutEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const uploadFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) {
        timeline.appendNotice(
          `${file.name} is larger than the 20 MB upload limit.`,
          "error",
        );
        continue;
      }
      try {
        const data = await fileAsBase64(file);
        const result = await api.upload(
          tab.key,
          file.name,
          file.type || "application/octet-stream",
          data,
        );
        if (!result.ok || !result.path) {
          timeline.appendNotice(
            result.error ?? `Could not upload ${file.name}`,
            "error",
          );
          continue;
        }
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            path: result.path!,
            ...(file.type.startsWith("image/") ? { imageData: data } : {}),
          },
        ]);
      } catch (error) {
        timeline.appendNotice(
          error instanceof Error
            ? error.message
            : `Could not upload ${file.name}`,
          "error",
        );
      }
    }
  };

  const dragHasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setDragActive(true);
  };

  const onDragOver = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent) => {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    // relatedTarget is null only when the drag leaves the window/DOM entirely —
    // reset fully so a cancelled drag can never leave the overlay stuck on.
    if (dragCounterRef.current === 0 || event.relatedTarget === null) {
      dragCounterRef.current = 0;
      setDragActive(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragCounterRef.current = 0;
    setDragActive(false);
    void uploadFiles(event.dataTransfer?.files ?? null);
    textareaRef.current?.focus();
  };

  const onPasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    event.preventDefault();
    // macOS screenshots copied to the clipboard arrive unnamed; give them a
    // recognizable, sortable name before they hit the upload path.
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const base = `screenshot-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const named = files.map((file, index) => {
      const extension = file.type.split("/")[1] ?? "png";
      const suffix = files.length > 1 ? `-${index + 1}` : "";
      return file.name && file.name !== "image.png"
        ? file
        : new File([file], `${base}${suffix}.${extension}`, {
            type: file.type,
          });
    });
    void uploadFiles(named);
  };

  // Keep the document-level drop catcher pointed at the latest upload closure.
  const uploadFilesRef = useRef(uploadFiles);
  useLayoutEffect(() => {
    uploadFilesRef.current = uploadFiles;
  });

  // Whole-window drop catching: without this, files dropped outside the
  // conversation panel (header, workspace rail, page edges) fall through to
  // the browser default — the tab navigates to the image and the upload
  // silently never happens.
  useEffect(() => {
    // In split view each pane owns its own drop zone; a global listener would
    // make both panes race for the same files.
    if (split) return;
    const hasFiles = (event: globalThis.DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDocDragOver = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      // preventDefault outside .conversation is what makes the drop
      // deliverable there at all, and stops the browser from opening the file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDocDrop = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      // Inside the conversation panel the React handlers already own the drop.
      if (
        event.target instanceof Element &&
        event.target.closest(".conversation")
      )
        return;
      void uploadFilesRef.current(event.dataTransfer?.files ?? null);
      textareaRef.current?.focus();
    };
    document.addEventListener("dragover", onDocDragOver);
    document.addEventListener("drop", onDocDrop);
    return () => {
      document.removeEventListener("dragover", onDocDragOver);
      document.removeEventListener("drop", onDocDrop);
    };
  }, [split]);

  const configureSession = async (
    nextAccess: AccessMode,
    nextMode: AgentMode,
    nextCwd = tab.cwd,
  ) => {
    const switchingFolder = nextCwd !== tab.cwd;
    if (hasItems && !switchingFolder) {
      timeline.appendNotice(
        "Access and agent mode can only be changed before the first message.",
        "warning",
      );
      return;
    }
    if (hasItems && switchingFolder) {
      setConversationWorkspace(tab.key, nextCwd);
      openWorkspace();
      return;
    }
    setConfiguring(true);
    const result = await api.configure(
      tab.key,
      nextCwd,
      nextAccess,
      nextMode,
      state?.model,
      state?.thinkingLevel,
      undefined,
      tab.backend,
    );
    setConfiguring(false);
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ??
          `Could not reconfigure the ${backendLabel(tab.backend)} session`,
        "error",
      );
      return;
    }
    setAccessMode(nextAccess);
    setAgentMode(nextMode);
    timeline.reset(result.state);
    if (nextCwd !== tab.cwd) setConversationWorkspace(tab.key, nextCwd);
  };

  // Plan/auto can be switched mid-conversation: the backend restarts the agent
  // against the same session file (plan mode = different system prompt + tool
  // allowlist, which only apply at spawn time), so the transcript is reloaded
  // from the persisted session afterwards.
  const switchAgentMode = async (nextMode: AgentMode) => {
    if (configuring || nextMode === agentMode) return;
    if (!hasItems) {
      void configureSession(accessMode, nextMode);
      return;
    }
    if (streaming) {
      timeline.appendNotice(
        "Wait for the current response to finish before switching mode.",
        "warning",
      );
      return;
    }
    const sessionFile = state?.sessionFile;
    if (!sessionFile) {
      timeline.appendNotice(
        "Agent mode can only be changed before the first message.",
        "warning",
      );
      return;
    }
    setConfiguring(true);
    const result = await api.configure(
      tab.key,
      tab.cwd,
      accessMode,
      nextMode,
      state?.model,
      state?.thinkingLevel,
      sessionFile,
      tab.backend,
    );
    setConfiguring(false);
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ?? "Could not switch agent mode",
        "error",
      );
      return;
    }
    if (Array.isArray(result.messages))
      timeline.hydrate(result.messages, result.state);
    else timeline.reset(result.state);
    setAgentMode(nextMode);
    setConversationSessionPath(tab.key, sessionFile);
    timeline.appendNotice(
      nextMode === "plan"
        ? "Plan mode is on — read-only exploration until you run the plan."
        : "Auto mode is on.",
      "info",
    );
  };

  // Edit + resend: rewind the backend to just before the chosen message (the
  // server branches the session file there), record the edit as the newest
  // version of that message, then send the new prompt over the trimmed context.
  const resendEdited = async (itemId: string, text: string) => {
    const item = timeline.items.find((candidate) => candidate.id === itemId);
    if (!item || item.kind !== "user" || streaming) return;
    const versions = item.versions;
    const currentVersion = versions?.[item.versionIndex ?? 0];
    const fromSessionFile =
      currentVersion?.sessionFile ?? state?.sessionFile ?? "";
    const result = await api.truncate(
      tab.key,
      currentVersion?.timestamp ?? item.timestamp,
      fromSessionFile || undefined,
    );
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ?? "Could not rewind the conversation for editing",
        "error",
      );
      return;
    }
    timeline.editUserMessage(
      itemId,
      text,
      fromSessionFile,
      result.state.sessionFile ?? fromSessionFile,
    );
    setConversationSessionPath(tab.key, result.state.sessionFile);
    stickToBottom.current = true;
    const sent = await api.prompt(tab.key, text, { images: [] });
    if (!sent.ok) {
      timeline.appendNotice(sent.error ?? "prompt failed", "error");
    }
  };

  // Claude-Code-style ‹ › navigation: rebind the backend to the session file
  // that contains the chosen version, rewound to just before its prompt.
  const selectUserVersion = async (
    item: Extract<TimelineItem, { kind: "user" }>,
    targetIndex: number,
  ) => {
    if (streaming || editingMessageId !== null) return;
    const target = item.versions?.[targetIndex];
    if (!target || targetIndex === (item.versionIndex ?? 0)) return;
    const result = await api.truncate(
      tab.key,
      target.timestamp,
      target.sessionFile || undefined,
    );
    if (!result.ok || !result.state) {
      timeline.appendNotice(
        result.error ?? "Could not switch to that version",
        "error",
      );
      return;
    }
    timeline.setUserVersion(
      item.id,
      targetIndex,
      result.state.sessionFile ?? target.sessionFile,
    );
    setConversationSessionPath(tab.key, result.state.sessionFile);
  };

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message && attachments.length === 0) return;
    // Edited-message resend: the composer is attached to an existing user
    // message; resend it over the rewound context instead of appending a turn.
    if (editingMessageId !== null) {
      if (attachments.length > 0) {
        timeline.appendNotice(
          "Remove attachments to resend an edited message.",
          "warning",
        );
        return;
      }
      const itemId = editingMessageId;
      setDraft("");
      setEditingMessageId(null);
      if (!message) return;
      await resendEdited(itemId, message);
      return;
    }
    if (
      attachments.length === 0 &&
      (message === "/new" || message === "/clear")
    ) {
      const result = await api.newSession(tab.key);
      if (result.ok && result.state && Array.isArray(result.messages)) {
        timeline.hydrate(result.messages, result.state);
        setConversationSessionPath(tab.key, undefined);
      } else if (!result.ok) {
        timeline.appendNotice(
          result.error ??
            `Could not create a new ${backendLabel(tab.backend)} session`,
          "error",
        );
      }
      refreshSessions();
      setDraft("");
      return;
    }
    if (attachments.length === 0 && message === "/compact") {
      const result = await api.compact(tab.key);
      setDraft("");
      if (result.ok)
        timeline.appendNotice(
          "Conversation compacted — older history is now summarized.",
          "info",
        );
      else
        timeline.appendNotice(
          result.error ?? "Could not compact the conversation",
          "error",
        );
      return;
    }
    if (attachments.length === 0 && isUsageShortcut(message)) {
      setDraft("");
      if (!(await refreshUsage(true)))
        timeline.appendNotice("Could not retrieve usage", "error");
      return;
    }
    if (
      attachments.length === 0 &&
      (message === "/usage" || message === "/cost")
    ) {
      setDraft("");
      const retrieved = await refreshUsage(true);
      timeline.appendNotice(
        retrieved
          ? "Usage refreshed — current windows are shown in the composer status bar."
          : "Could not retrieve usage",
        retrieved ? "info" : "error",
      );
      return;
    }
    if (message === "/export") {
      setDraft("");
      const markdown = timelineToMarkdown(timeline.items, {
        title: displayTitle,
        backend: backendLabel(tab.backend),
        model: state?.model?.name ?? state?.model?.id,
        cwd: tab.cwd,
      });
      const name = exportFilename(displayTitle);
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on the next tick so the download has taken the handle.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      timeline.appendNotice(`Exported this conversation to ${name}.`, "info");
      return;
    }
    if (message === "/context") {
      setDraft("");
      const userTurns = timeline.items.filter(
        (item) => item.kind === "user",
      ).length;
      const toolCalls = timeline.items.filter(
        (item) => item.kind === "tool",
      ).length;
      // Prefer the backend's own accounting; fall back to the estimate.
      const usage = context.exact
        ? context
        : estimateContext(timeline.items, state ?? null);
      const qualifier = usage.exact ? "" : "~";
      const breakdown = (usage.categories ?? [])
        .slice(0, 5)
        .map((entry) => `${entry.name} ${compactTokens(entry.tokens)}`)
        .join(", ");
      timeline.appendNotice(
        `Context use: ${qualifier}${compactTokens(usage.estimatedTokens)} of ${compactTokens(usage.contextWindow)} tokens (${usage.percent}%) — ${userTurns} user turns, ${toolCalls} tool calls${breakdown ? `. Largest: ${breakdown}` : ", plus the system prompt and tool definitions"}.${usage.autoCompactAt ? ` Auto-compacts at ${compactTokens(usage.autoCompactAt)}.` : ""} /compact squeezes older history before a new phase; /clear starts fresh.`,
        "info",
      );
      return;
    }
    if (message === "/diff") {
      setDraft("");
      const changes = timeline.items.filter(
        (item): item is Extract<TimelineItem, { kind: "tool" }> =>
          item.kind === "tool" &&
          ["edit", "write"].includes(item.name.toLowerCase()),
      );
      const lines: DiffLine[] = [];
      const files = new Set<string>();
      for (const item of changes) {
        const diff = getToolDiff(item);
        if (!diff) continue;
        const path = String(
          item.args.path ?? item.args.file_path ?? "(unknown)",
        );
        if (!files.has(path)) {
          files.add(path);
          lines.push({
            kind: "meta",
            text: `── ${path}${item.name.toLowerCase() === "write" ? "  (new file)" : ""}`,
          });
        }
        lines.push(...diff.lines);
      }
      if (lines.length === 0) {
        timeline.appendNotice("No file changes in this session yet.", "info");
        return;
      }
      setViewer({
        title: `Session diff · ${files.size} file${files.size === 1 ? "" : "s"} · ${changes.length} change${changes.length === 1 ? "" : "s"}`,
        diff: {
          added: lines.filter((line) => line.kind === "add").length,
          removed: lines.filter((line) => line.kind === "remove").length,
          lines,
        },
      });
      return;
    }
    if (message === "/fork" || /^\/fork\s+\d+$/.test(message)) {
      setDraft("");
      const arg = Number(message.slice(5).trim() || "1");
      const position = Number.isFinite(arg) && arg >= 1 ? Math.floor(arg) : 1;
      const assistants = timeline.items.filter(
        (item): item is Extract<TimelineItem, { kind: "assistant" }> =>
          item.kind === "assistant" && !item.live,
      );
      const target = assistants.at(-Math.min(position, assistants.length));
      if (!target) {
        timeline.appendNotice(
          "Nothing to fork yet — send a message first.",
          "warning",
        );
        return;
      }
      await forkOutput(target);
      return;
    }
    if (message.startsWith("/goal")) {
      const arg = message.slice(5).trim();
      setDraft("");
      if (!arg) {
        timeline.appendNotice(
          "Usage: /goal <one concrete outcome> — the agent checks in automatically (after 30m, then 1h → 2h). /goal off clears it.",
          "info",
        );
        return;
      }
      const result = await api.goal(tab.key, arg);
      if (!result.ok) {
        timeline.appendNotice(
          result.error ?? "Could not set the goal",
          "error",
        );
        return;
      }
      timeline.appendNotice(
        result.cleared
          ? "Standing goal cleared."
          : `Goal parked — the agent checks in on its own (after 30m, then every 1h → 2h): ${arg}`,
        "info",
      );
      return;
    }
    if (message === "/push" || message === "/pull") {
      const op = message.slice(1) as "push" | "pull";
      setDraft("");
      timeline.appendNotice(`Running git ${op} in ${tab.cwd}…`, "info");
      const result = await api.gitRun(tab.key, tab.cwd, op);
      if (result.ok) {
        const output = (result.output ?? "").trim();
        timeline.appendNotice(
          output ? `git ${op}:\n${output}` : `git ${op} finished.`,
          "info",
        );
      } else {
        timeline.appendNotice(result.error ?? `git ${op} failed`, "error");
      }
      return;
    }
    const pickedAttachments = attachments;
    const attachmentLines = pickedAttachments.map(
      (attachment) => `- ${attachment.name}: ${attachment.path}`,
    );
    const outboundMessage = [
      message || "Please inspect the attached file(s).",
      attachmentLines.length
        ? `Attached files:\n${attachmentLines.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const displayMessage = [
      message || "Attached file(s)",
      pickedAttachments.length
        ? `Attachments: ${pickedAttachments.map((attachment) => attachment.name).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const images = pickedAttachments
      .filter((attachment) => attachment.imageData)
      .map((attachment) => ({
        type: "image" as const,
        data: attachment.imageData!,
        mimeType: attachment.mimeType,
      }));
    timeline.appendUser(displayMessage);
    setDraft("");
    setAttachments([]);
    stickToBottom.current = true;
    // Optimistic pending-run state: the RPC prompt response only arrives when
    // the whole turn completes, and agent_start can lag (a stalled model call
    // once left the UI silent for 225s). Show "working" immediately so the
    // user always knows the request was sent — and has a stop affordance.
    timeline.markPendingRun();

    // A model's natural-language self-identification is not authoritative:
    // aliases and provider prompts can make Luna claim to be Kimi. For this
    // narrow question, answer from the session state that Pi reports instead.
    if (
      pickedAttachments.length === 0 &&
      state?.model &&
      isModelIdentityQuestion(message)
    ) {
      timeline.clearPendingRun();
      timeline.appendAssistant(runtimeModelAnswer(state.model));
      return;
    }

    const promptOptions = {
      images,
      cwd: tab.cwd,
      backend: tab.backend,
      sessionPath: tab.sessionPath ?? state?.sessionFile ?? undefined,
      model: state?.model ?? undefined,
      thinkingLevel: state?.thinkingLevel ?? undefined,
    };
    // Mid-turn, a new prompt waits its turn instead of being spliced into the
    // running one — and stays cancellable while it waits. Backends without a
    // queue keep the old steer behaviour.
    const steerNow = steerOnceRef.current || midTurnMode === "steer";
    steerOnceRef.current = false;
    const result = streaming
      ? tab.backend === "claude" && !steerNow
        ? await api.enqueue(tab.key, outboundMessage, images)
        : await api.steer(tab.key, outboundMessage, images)
      : await api.prompt(tab.key, outboundMessage, promptOptions);
    if (!result.ok) {
      setAttachments(pickedAttachments);
      timeline.clearPendingRun();
      timeline.appendNotice(result.error ?? "prompt failed", "error");
    }
  };

  useEffect(() => {
    if (state?.sessionFile)
      setConversationSessionPath(tab.key, state.sessionFile);
  }, [setConversationSessionPath, state?.sessionFile, tab.key]);

  useEffect(() => {
    if (state?.model) setPreferredModel(tab.backend, tab.cwd, state.model);
  }, [setPreferredModel, state?.model, tab.backend, tab.cwd]);

  useEffect(() => {
    const closeFloatingMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        addDetailsRef.current?.open &&
        !addDetailsRef.current.contains(target)
      ) {
        addDetailsRef.current.open = false;
      }
      if (commandMenuOpen && !target.closest(".composer"))
        setCommandMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeFloatingMenus);
    return () =>
      document.removeEventListener("pointerdown", closeFloatingMenus);
  }, [commandMenuOpen]);

  // slash filtering for the command menu opened by typing "/"
  const localByName = new Map(
    LOCAL_COMMANDS.map((command) => [command.name, command]),
  );
  const mergedCommands = [
    ...LOCAL_COMMANDS,
    ...commands.filter((command) => !localByName.has(command.name)),
  ];
  // The "@" token under the caret, if any: an @ that starts a word, followed
  // by anything but whitespace.
  const mentionQuery = (() => {
    const before = draft.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    return match ? match[1] : null;
  })();
  const mentionOpen = mentionQuery !== null && mentionMatches.length > 0;

  // Debounced so a fast typist does not walk the tree on every keystroke.
  // Declared here rather than with the other effects because the dependency
  // array is evaluated during render and mentionQuery is derived just above.
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionMatches([]);
      return;
    }
    const root = tab.cwd;
    if (!root) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .workspaceSearch(root, mentionQuery)
        .then((result) => {
          if (cancelled) return;
          setMentionMatches(result.ok ? (result.matches ?? []) : []);
          setMentionIndex(0);
        })
        .catch(() => {
          if (!cancelled) setMentionMatches([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mentionQuery, tab.cwd]);

  const bareSlashCommand = /^\/([\w:-]*)$/.exec(draft);
  const slashFilter = bareSlashCommand
    ? bareSlashCommand[1].toLowerCase()
    : null;
  const slashMatches =
    slashFilter !== null && slashFilter.length >= 0
      ? mergedCommands
          .filter((c) => c.name.toLowerCase().startsWith(slashFilter))
          .slice(0, 8)
      : mergedCommands.slice(0, 8);
  const slashOpen =
    commandMenuOpen || (slashFilter !== null && slashMatches.length > 0);

  /** Swap the "@token" under the caret for the picked path. */
  const applyMention = (match: WorkspaceMatch) => {
    const before = draft.slice(0, caret);
    const start = before.search(/(?:^|\s)@[^\s@]*$/);
    const at = before.indexOf("@", start === -1 ? 0 : start);
    if (at === -1) return;
    const next = `${draft.slice(0, at)}@${match.relativePath} ${draft.slice(caret)}`;
    setDraft(next);
    setMentionMatches([]);
    const caretAfter = at + match.relativePath.length + 2;
    window.setTimeout(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caretAfter, caretAfter);
      setCaret(caretAfter);
      autoGrow();
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Steer the running turn, whatever the mid-turn default is.
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      streaming &&
      draft.trim()
    ) {
      event.preventDefault();
      steerOnceRef.current = true;
      void send(draft);
      return;
    }
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
        );
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        applyMention(
          mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)],
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionMatches([]);
        return;
      }
    }
    if (slashOpen && slashMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length,
        );
        return;
      }
      if (
        event.key === "Tab" ||
        (event.key === "Enter" && slashFilter !== null && draft.length > 1)
      ) {
        event.preventDefault();
        const picked =
          slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
        setCommandMenuOpen(false);
        if (!picked) return;
        setDraft(`/${picked.name} `);
        if (event.key === "Enter") {
          // Selecting a command and pressing enter fires it right away. The
          // trailing space in the draft closes the menu and lets arguments
          // follow on the next keystrokes.
          void send(`/${picked.name}`);
        }
        return;
      }
      if (event.key === "Escape") {
        setCommandMenuOpen(false);
        return;
      }
    }
    if (event.key === "Escape" && editingMessageId !== null) {
      event.preventDefault();
      setEditingMessageId(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
    }
  };

  const textareaMinHeight = 48;
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, textareaMinHeight), 196)}px`;
  }, []);
  useLayoutEffect(() => {
    autoGrow();
  });

  const modelOptions: ModelOption[] = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label:
      tab.backend === "claude" || m.provider === "anthropic"
        ? formatClaudeModelName(m.name ?? m.id)
        : (m.name ?? m.id),
  }));
  const activeModel =
    state?.model ??
    (tab.backend === "claude" && tab.isFresh ? CLAUDE_DEFAULT_MODEL : null);
  const currentModel = activeModel
    ? `${activeModel.provider}/${activeModel.id}`
    : "";
  const currentModelLabel =
    modelOptions.find(
      (option) => `${option.provider}/${option.id}` === currentModel,
    )?.label ??
    (tab.backend === "claude" && activeModel
      ? formatClaudeModelName(activeModel.name ?? activeModel.id)
      : activeModel?.name) ??
    activeModel?.id ??
    "model…";
  const effort =
    state?.thinkingLevel ??
    (tab.backend === "claude" && tab.isFresh ? CLAUDE_DEFAULT_EFFORT : "off");

  const setModel = (value: string) => {
    const option = modelOptions.find(
      (candidate) => `${candidate.provider}/${candidate.id}` === value,
    );
    if (!option) return;
    void api.setModel(tab.key, option.provider, option.id).then((result) => {
      if (!result.ok) {
        timeline.appendNotice(result.error ?? "Could not set model", "error");
        return;
      }
      if (result.state) {
        timeline.setState(result.state);
        setPreferredModel(tab.backend, tab.cwd, result.state.model);
      } else {
        const model =
          result.data ??
          models.find(
            (candidate) =>
              candidate.provider === option.provider &&
              candidate.id === option.id,
          ) ??
          option;
        if (timeline.state) {
          timeline.setState({ ...timeline.state, model });
          setPreferredModel(tab.backend, tab.cwd, model);
        }
      }
      void api.thinkingLevels(tab.key, tab.backend).then((levelResult) => {
        if (levelResult.ok && Array.isArray(levelResult.levels))
          setLevels(levelResult.levels);
      });
      void refreshUsage(true);
    });
  };

  const setEffort = (level: string) => {
    void api.setThinking(tab.key, level).then((result) => {
      if (!result.ok) {
        timeline.appendNotice(
          result.error ?? "Could not set thinking level",
          "error",
        );
        return;
      }
      if (timeline.state)
        timeline.setState({ ...timeline.state, thinkingLevel: level });
    });
  };

  const interrupt = useCallback(() => {
    void api.abort(tab.key);
  }, [tab.key]);

  const forkOutput = async (
    item: Extract<TimelineItem, { kind: "assistant" }>,
  ) => {
    if (streaming || forkingId) return;
    setForkingId(item.id);
    const result = await api.fork(tab.key, item.timestamp);
    setForkingId(null);
    if (!result.ok || !result.state || !Array.isArray(result.messages)) {
      timeline.appendNotice(
        result.error ?? "Could not fork this response",
        "error",
      );
      return;
    }
    // Pi restores the live session and hands back the branch as a separate
    // session file (state = the branched session): open the branch as its own
    // side chat instead of replacing this conversation. The backend also
    // creates a git worktree for the branch when the workspace is a git repo,
    // so the fork never annotates the original working copy.
    if (result.restored && result.state.sessionFile) {
      const forkKey = openForkedConversation({
        cwd: result.forkCwd ?? tab.cwd,
        sessionPath: result.state.sessionFile,
        messages: result.messages,
        state: result.state,
        label: `${tab.label} · fork`,
        backend: tab.backend,
      });
      refreshSessions();
      onSessionSplit?.(forkKey);
      timeline.appendNotice("Forked into a side conversation.", "info");
      return;
    }
    timeline.hydrate(result.messages, result.state);
    setConversationSessionPath(tab.key, result.state.sessionFile);
    refreshSessions();
  };

  const setupChips = (
    <div className="composer__setup">
      <div className="hero__chips">
        <WorkspacePicker
          ref={hasItems ? undefined : workspacePickerRef}
          cwd={tab.cwd}
          backend={tab.backend}
          disabled={configuring}
          onPick={(path) => configureSession(accessMode, agentMode, path)}
          onViewWorkspace={openWorkspace}
        />
        <button
          type="button"
          className={`workspace-picker__trigger${workspaceOpen ? " is-active" : ""}`}
          aria-pressed={workspaceOpen}
          title={tab.cwd}
          onClick={toggleWorkspace}
        >
          <IconCode size={15} />
          <span>View workspace</span>
        </button>
        <div className="native-select native-select--chip native-select--mode">
          <span className="native-select__icon">
            <IconCube size={15} />
          </span>
          <select
            aria-label="Agent mode"
            value={agentMode}
            disabled={configuring}
            onChange={(event) =>
              void configureSession(accessMode, event.target.value as AgentMode)
            }
          >
            <option value="standard">Auto mode</option>
            <option value="plan">Plan mode</option>
          </select>
          <span className="native-select__chev">
            <IconChevronDown size={13} />
          </span>
        </div>
      </div>
    </div>
  );

  const dropZoneProps = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
  const dropOverlay = dragActive ? (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__card">
        <IconUpload />
        <span>Drop to attach — 20 MB max</span>
      </div>
    </div>
  ) : null;

  const composer = (
    <div className="composer">
      {!hasItems && setupChips}
      {hasItems && (
        <WorkspacePicker
          ref={workspacePickerRef}
          cwd={tab.cwd}
          backend={tab.backend}
          disabled={configuring}
          hideTrigger
          onPick={(path) => configureSession(accessMode, agentMode, path)}
          onViewWorkspace={openWorkspace}
        />
      )}
      {editingMessageId !== null && (
        <div className="composer__editing" role="status">
          <span>Editing message — press Enter to resend, Esc to cancel</span>
          <button
            type="button"
            onClick={() => {
              setEditingMessageId(null);
              setDraft("");
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {mentionOpen && (
        <div className="slash-menu mention-menu">
          {mentionMatches.map((match, index) => (
            <button
              key={match.path}
              type="button"
              className={`slash-menu__item${index === mentionIndex ? " is-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                applyMention(match);
              }}
            >
              <code>{match.name}</code>
              <span>{match.relativePath}</span>
            </button>
          ))}
        </div>
      )}
      {slashOpen && slashMatches.length > 0 && (
        <div className="slash-menu">
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              className={`slash-menu__item${index === slashIndex ? " is-active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraft(`/${command.name} `);
                setCommandMenuOpen(false);
                textareaRef.current?.focus();
              }}
            >
              <code>/{command.name}</code>
              <span>{command.description ?? ""}</span>
              <em>{command.source ?? "pi"}</em>
            </button>
          ))}
        </div>
      )}
      {streaming && todos.length > 0 && <TodoTracker tasks={todos} />}
      {queued.length > 0 && (
        <div className="queue-strip" aria-label="Queued messages">
          <p className="queue-strip__hint">
            Waiting for this turn to finish — ⌘/Ctrl+Enter sends into the running
            turn instead.
          </p>
          {queued.map((item, index) => (
            <div key={item.id} className="queue-chip">
              <span className="queue-chip__index">{index + 1}</span>
              <span className="queue-chip__text">{item.message}</span>
              <button
                type="button"
                aria-label="Remove from queue"
                title="Remove from queue"
                onClick={() => void api.cancelQueued(tab.key, item.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        className="composer__card"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          ref={fileInputRef}
          className="composer__file-input"
          type="file"
          multiple
          onChange={(event) => {
            void uploadFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {attachments.length > 0 && (
          <div className="composer__attachments" aria-label="Attached files">
            {attachments.map((attachment) => {
              const removeAttachment = () =>
                setAttachments((current) =>
                  current.filter((candidate) => candidate.id !== attachment.id),
                );
              if (attachment.imageData) {
                const src = `data:${attachment.mimeType};base64,${attachment.imageData}`;
                return (
                  <span
                    className="attachment-chip attachment-chip--image"
                    key={attachment.id}
                    title={attachment.path}
                  >
                    <button
                      type="button"
                      className="attachment-chip__preview"
                      aria-label={`Preview ${attachment.name}`}
                      onClick={() =>
                        setViewer({ title: attachment.name, imageSrc: src })
                      }
                    >
                      <img src={src} alt="" />
                      <span>{attachment.name}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={removeAttachment}
                    >
                      ×
                    </button>
                  </span>
                );
              }
              return (
                <span
                  className="attachment-chip"
                  key={attachment.id}
                  title={attachment.path}
                >
                  <IconFile size={14} />
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={removeAttachment}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="composer__scroll">
          <textarea
            ref={textareaRef}
            className="composer__textarea"
            rows={2}
            placeholder={
              editingMessageId === null
                ? "Describe what you want to build"
                : "Edit your message…"
            }
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              if (commandMenuOpen) setCommandMenuOpen(false);
              autoGrow();
            }}
            onSelect={(e) =>
              setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
            }
            onKeyDown={onKeyDown}
            onPaste={onPasteImage}
          />
        </div>
        <div className="composer__row">
          <div className="composer__tools">
            <details ref={addDetailsRef} className="add-disclosure">
              <summary className="composer__add" aria-label="Add">
                <IconPlus />
              </summary>
              <div className="native-add-menu">
                <button
                  type="button"
                  onClick={() => {
                    if (addDetailsRef.current)
                      addDetailsRef.current.open = false;
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="native-add-menu__icon">
                    <IconUpload />
                  </span>
                  <span>Upload file</span>
                  <em>20 MB max</em>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (addDetailsRef.current)
                      addDetailsRef.current.open = false;
                    workspacePickerRef.current?.openBrowser();
                  }}
                >
                  <span className="native-add-menu__icon">
                    <IconFolderPlus />
                  </span>
                  <span>Add project</span>
                  <em>Folder as workspace</em>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (addDetailsRef.current)
                      addDetailsRef.current.open = false;
                    loadCommands();
                    setCommandMenuOpen(true);
                    setSlashIndex(0);
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="native-add-menu__icon">
                    <IconCommand />
                  </span>
                  <span>Slash commands</span>
                  <em>
                    {commands.length} from {backendLabel(tab.backend)}
                  </em>
                </button>
              </div>
            </details>
            {streaming && (
              <div className="native-select native-select--chip native-select--mode">
                <select
                  aria-label="What Enter does while the agent is working"
                  title="Queue waits for this turn to finish. Steer pushes the message into the turn that is already running (⌘/Ctrl+Enter always steers)."
                  value={midTurnMode}
                  onChange={(event) =>
                    chooseMidTurnMode(event.target.value as "queue" | "steer")
                  }
                >
                  <option value="queue">Queue next</option>
                  <option value="steer">Steer now</option>
                </select>
                <span className="native-select__chev">
                  <IconChevronDown size={13} />
                </span>
              </div>
            )}
            {hasItems && (
              <div className="native-select native-select--chip native-select--mode">
                <span className="native-select__icon">
                  <IconCube size={15} />
                </span>
                <select
                  aria-label="Agent mode"
                  value={agentMode}
                  disabled={configuring || streaming}
                  onChange={(event) =>
                    void switchAgentMode(event.target.value as AgentMode)
                  }
                >
                  <option value="standard">Auto mode</option>
                  <option value="plan">Plan mode</option>
                </select>
                <span className="native-select__chev">
                  <IconChevronDown size={13} />
                </span>
              </div>
            )}
          </div>
          <div className="composer__trailing">
            {providerUsage?.available && (
              <>
                <UsageSummary usage={providerUsage} />
                <span className="usage-summary__rule" aria-hidden="true" />
              </>
            )}
            <div
              className="native-model-controls"
              onPointerDown={loadModelMetadata}
              onFocus={loadModelMetadata}
            >
              <IconCube size={15} />
              <span
                className="native-model-controls__field native-model-controls__field--model"
                title={currentModelLabel}
              >
                <span className="native-model-controls__value">
                  {currentModelLabel}
                </span>
                <span className="native-select__chev">
                  <IconChevronDown size={13} />
                </span>
                <select
                  aria-label="Model"
                  value={currentModel}
                  disabled={configuring || streaming}
                  title={
                    streaming
                      ? "Wait for the current response to finish before changing model"
                      : "Change model for the next message"
                  }
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!currentModel && <option value="">model…</option>}
                  {currentModel &&
                    !modelOptions.some(
                      (option) =>
                        `${option.provider}/${option.id}` === currentModel,
                    ) && (
                      <option value={currentModel}>
                        {tab.backend === "claude"
                          ? formatClaudeModelName(
                              state?.model?.name ??
                                state?.model?.id ??
                                currentModel,
                            )
                          : (state?.model?.name ??
                            state?.model?.id ??
                            currentModel)}
                      </option>
                    )}
                  {modelOptions.map((option) => (
                    <option
                      key={`${option.provider}/${option.id}`}
                      value={`${option.provider}/${option.id}`}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </span>
              <span
                className="native-model-controls__field native-model-controls__field--effort"
                title={`Effort: ${effort}`}
              >
                <span className="native-model-controls__value">{effort}</span>
                <span className="native-select__chev">
                  <IconChevronDown size={13} />
                </span>
                <select
                  aria-label="Effort"
                  value={effort}
                  disabled={configuring || streaming}
                  onChange={(event) => setEffort(event.target.value)}
                >
                  {!levels.includes(effort) && (
                    <option value={effort}>{effort}</option>
                  )}
                  {levels.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            {streaming ? (
              <button
                type="button"
                className="composer__primary is-stop"
                aria-label="Stop"
                onClick={() => void api.abort(tab.key)}
              >
                <IconStop />
              </button>
            ) : (
              <button
                type="submit"
                className="composer__primary"
                aria-label="Send"
                disabled={!draft.trim() && attachments.length === 0}
              >
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );

  const addWorkspacePathToChat = useCallback(
    (path: string) => {
      chooseWorkspacePlacement("side");
      const insertion = path.startsWith(`${tab.cwd}/`)
        ? path.slice(tab.cwd.length + 1)
        : path;
      setDraft((current) => {
        if (!current.trim()) return insertion;
        return current.endsWith("\n")
          ? `${current}${insertion}`
          : `${current}\n${insertion}`;
      });
      const name = path.split("/").filter(Boolean).at(-1) ?? path;
      setAttachments((current) =>
        current.some((item) => item.path === path)
          ? current
          : [
              ...current,
              {
                id: crypto.randomUUID(),
                name,
                mimeType: "text/plain",
                size: 0,
                path,
              },
            ],
      );
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [tab.cwd],
  );

  const workspaceExplorer = workspaceMounted ? (
    <WorkspaceExplorer
      key={tab.cwd}
      root={tab.cwd}
      visible={workspaceOpen}
      placement={workspacePlacement}
      onPlacementChange={chooseWorkspacePlacement}
      onClose={closeWorkspace}
      onAddToChat={addWorkspacePathToChat}
    />
  ) : null;

  if (!hasItems) {
    return (
      <>
        {split && (
          <div className="conversation-header conversation-header--empty">
            <div
              className="conversation-header__hover-strip"
              aria-hidden="true"
            />
            <div className="conversation-header__top">
              <div
                className="conversation-header__identity"
                title={`${displayTitle}\n${tab.cwd}`}
              >
                <span className="conversation-header__pane-label">
                  Session {paneIndex + 1} of {paneCount}
                </span>
                <div className="conversation-header__title">{displayTitle}</div>
                <div className="conversation-header__path">{tab.cwd}</div>
              </div>
              <span
                className={`conversation-header__backend is-${tab.backend}`}
              >
                {backendLabel(tab.backend)}
              </span>
              <div className="conversation-header__spacer" />
              <button
                type="button"
                className={`conversation-header__download conversation-header__icon-btn${workspaceOpen ? " is-active" : ""}`}
                aria-pressed={workspaceOpen}
                aria-label="View project source"
                title="View project source"
                onClick={toggleWorkspace}
              >
                <IconCode size={14} />
              </button>
              {onClose && (
                <button
                  type="button"
                  className="conversation-header__close"
                  aria-label={`Close ${displayTitle}`}
                  title="Close session"
                  onClick={onClose}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )}
        <div className="conversation-stage">
          <div className="conversation conversation--empty" {...dropZoneProps}>
            {/* Standalone hero with flex: 1 — it centers the headline in the
                free space and pushes the composer down, exactly like the
                pre-grok layout. Nesting it inside the (top-aligned, flex:
                none) composer killed the centering. */}
            <div className="hero">
              <div className="hero__glow" />
              <div className="hero__stack">
                <div className="hero__headline">
                  <span className="hero__fish">
                    <FishLogo size={34} />
                  </span>
                  <span className="hero__title">Onwards &amp; Upwards</span>
                  <span className="hero__badge">Preview</span>
                </div>
              </div>
            </div>
            {composer}
            {dropOverlay}
          </div>
          {workspaceExplorer}
        </div>
        {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      </>
    );
  }

  return (
    <>
      <div className="conversation-header">
        <div className="conversation-header__hover-strip" aria-hidden="true" />
        <div className="conversation-header__top">
          <div
            className="conversation-header__identity"
            title={`${displayTitle}\n${tab.cwd}`}
          >
            {split && (
              <span className="conversation-header__pane-label">
                Session {paneIndex + 1} of {paneCount}
              </span>
            )}
            <div className="conversation-header__title">{displayTitle}</div>
            {split && (
              <div className="conversation-header__path">{tab.cwd}</div>
            )}
          </div>
          {split && (
            <span className={`conversation-header__backend is-${tab.backend}`}>
              {backendLabel(tab.backend)}
            </span>
          )}
          {agentMode === "plan" && (
            <div className="conversation-header__mode">
              <IconCube size={13} /> Plan mode
            </div>
          )}
          {status === "working" && (
            <div className="conversation-header__status">Working</div>
          )}
          <div className="conversation-header__spacer" />
          {onClose && (
            <button
              type="button"
              className="conversation-header__close"
              aria-label={`Close ${displayTitle}`}
              title="Close session"
              onClick={onClose}
            >
              ×
            </button>
          )}
        </div>
        <ContextFill context={context} />
        <div
          className="conversation-header__tabs"
          role="tablist"
          aria-label="Conversation view"
        >
          <button
            type="button"
            role="tab"
            aria-selected={conversationView === "chat"}
            className={conversationView === "chat" ? "is-active" : ""}
            onClick={() => setConversationView("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={conversationView === "trajectory"}
            className={conversationView === "trajectory" ? "is-active" : ""}
            onClick={() => setConversationView("trajectory")}
          >
            Trajectory
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={conversationView === "backend"}
            className={conversationView === "backend" ? "is-active" : ""}
            onClick={() => setConversationView("backend")}
          >
            Backend log
          </button>
          <div className="conversation-header__tabs-actions">
            <DeployButton />
            <button
              type="button"
              className={`conversation-header__download conversation-header__icon-btn${workspaceOpen ? " is-active" : ""}`}
              aria-pressed={workspaceOpen}
              aria-label="View project source"
              title="View project source"
              onClick={toggleWorkspace}
            >
              <IconCode size={14} />
            </button>
            <button
              type="button"
              className="conversation-header__download conversation-header__icon-btn"
              aria-label="Session details"
              title="Session details"
              onClick={() => setSessionDetailsOpen(true)}
            >
              <IconInfo size={14} />
            </button>
          </div>
        </div>
        {streaming && <div className="activity-line" aria-hidden="true" />}
      </div>

      <div className="conversation-stage">
        <div className="conversation" {...dropZoneProps}>
          {conversationView === "chat" ? (
            <div
              className="conversation__scroll"
              ref={scrollRef}
              onScroll={onScroll}
              role="tabpanel"
              aria-label="Chat"
              tabIndex={0}
            >
              <div className="conversation__column">
                {chatRows.map((row) =>
                  row.kind === "summary" ? (
                    <ToolActivitySummary
                      key={row.id}
                      items={row.items}
                      onOpen={setToolRail}
                    />
                  ) : (
                    <TimelineRow
                      key={row.item.id}
                      item={row.item}
                      onOpenFile={setViewer}
                      onFork={stableRowHandlers.onFork}
                      onRewindFiles={stableRowHandlers.onRewindFiles}
                      subagentChildren={subagentChildren}
                      forking={forkingId === row.item.id}
                      showActions={responseActionIds.has(row.item.id)}
                      showModelTag={row.item.id === lastAssistantId}
                      editingId={editingMessageId}
                      streaming={streaming}
                      onEditMessage={stableRowHandlers.onEditMessage}
                      onCancelEdit={stableRowHandlers.onCancelEdit}
                      onVersionChange={stableRowHandlers.onVersionChange}
                    />
                  ),
                )}
                {!streaming && <TodoTranscript tasks={todos} />}
                {!streaming && hasItems && tab.cwd && (
                  <ChangesPanel
                    sessionKey={tab.key}
                    cwd={tab.cwd}
                    streaming={streaming}
                    onAskAgent={(prompt) =>
                      setDraft((current) =>
                        current.trim() ? `${current}\n\n${prompt}` : prompt,
                      )
                    }
                  />
                )}
                {streaming && runningShell ? (
                  <ActiveRunIndicator
                    item={runningShell}
                    onInterrupt={interrupt}
                  />
                ) : streaming && !showingLiveText ? (
                  <ThinkingRow backend={tab.backend} />
                ) : null}
              </div>
            </div>
          ) : conversationView === "trajectory" ? (
            <div
              className="conversation__scroll conversation__scroll--trajectory"
              role="tabpanel"
              aria-label="Trajectory"
              tabIndex={0}
            >
              <Trajectory items={timeline.items} />
            </div>
          ) : (
            <div
              className="conversation__scroll conversation__scroll--backend"
              role="tabpanel"
              aria-label="Backend log"
              tabIndex={0}
            >
              <BackendLog entries={timeline.backendLog} live={streaming} />
            </div>
          )}
          {conversationView === "chat" && composer}
          {dropOverlay}
        </div>
        {workspaceExplorer}
      </div>

      {viewer && <FileViewer view={viewer} onClose={() => setViewer(null)} />}
      {toolRail && (
        <ToolDetailsRail group={toolRail} onClose={() => setToolRail(null)} />
      )}
      {sessionDetailsOpen && (
        <div className="viewer" onClick={() => setSessionDetailsOpen(false)}>
          <div
            className="viewer__panel session-details"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="viewer__head">
              <span>Session details</span>
              <button
                type="button"
                className="viewer__close"
                aria-label="Close"
                onClick={() => setSessionDetailsOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="session-details__body">
              <div className="details__row">
                <span>session id</span>
                <code>{state?.sessionId ?? "—"}</code>
              </div>
              <div className="details__row details__row--path">
                <span>session file</span>
                <code title={state?.sessionFile}>
                  {state?.sessionFile ?? "—"}
                </code>
              </div>
              <a
                className={`conversation-header__download${state?.sessionFile ? "" : " is-disabled"}`}
                href={
                  state?.sessionFile
                    ? api.sessionLogUrl(state.sessionFile)
                    : undefined
                }
                aria-disabled={!state?.sessionFile}
                download
                onClick={(event) => {
                  if (!state?.sessionFile) event.preventDefault();
                }}
              >
                Download session log <IconDownload size={14} />
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ThinkingRow({ backend }: { backend: ConversationTab["backend"] }) {
  const name = backendLabel(backend);
  return (
    <div className="thinking" aria-label={`${name} is thinking`}>
      <span className="thinking__spinner" />
      <span>{name} is thinking</span>
      <span className="thinking__dots" aria-hidden="true" />
    </div>
  );
}

function ContextFill({ context }: { context: ContextUsage }) {
  const percent = context.percent ?? 0;
  const nearLimit = percent >= 80;
  const title = context.exact
    ? [
        `${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used (${percent}%)`,
        context.autoCompactAt
          ? `Auto-compacts at ${context.autoCompactAt.toLocaleString()}.`
          : "",
        ...(context.categories ?? [])
          .slice(0, 6)
          .map((entry) => `${entry.name}: ${compactTokens(entry.tokens)}`),
      ]
        .filter(Boolean)
        .join("\n")
    : `Approximately ${context.estimatedTokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens used (estimated)`;
  return (
    <div
      className={`context-fill${nearLimit ? " is-near-limit" : ""}${context.exact ? " is-exact" : ""}`}
      role="progressbar"
      aria-label={`Context used: ${percent}%${context.exact ? "" : ", estimated"}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={title}
    >
      <span style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

/**
 * Memoized: streaming deltas tick the timeline many times a second, and a
 * long session re-parsing every RichText/diff row per tick froze the main
 * thread — the first paint after sending a prompt lagged for seconds, which
 * read as "nothing happened". Rows whose item and flags are unchanged now
 * skip re-rendering entirely.
 */
/**
 * "Undo the edits made since this message." Claude Code checkpoints every file
 * before it writes to it; this restores from those backups. It asks for the
 * preview first so the click is never blind — a rewind is not itself undoable.
 */
function RewindFilesButton({
  timestamp,
  disabled,
  onRewindFiles,
}: {
  timestamp: number;
  disabled?: boolean;
  onRewindFiles?: (
    timestamp: number,
    dryRun: boolean,
  ) => Promise<RewindFilesResult>;
}) {
  const [preview, setPreview] = useState<RewindFilesResult | null>(null);
  const [busy, setBusy] = useState(false);
  if (!onRewindFiles) return null;

  const ask = async () => {
    setBusy(true);
    try {
      setPreview(await onRewindFiles(timestamp, true));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await onRewindFiles(timestamp, false);
      setPreview(result.error ? result : null);
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    const count = preview.filesChanged?.length ?? 0;
    return (
      <span className="rewind">
        {preview.error ? (
          <span className="rewind__error">{preview.error}</span>
        ) : (
          <>
            <span className="rewind__summary">
              Restore {count} file{count === 1 ? "" : "s"}
              {preview.insertions !== undefined
                ? ` (+${preview.insertions}/−${preview.deletions ?? 0})`
                : ""}
              ?
            </span>
            <button
              type="button"
              className="rewind__confirm"
              disabled={busy || count === 0}
              onClick={() => void confirm()}
            >
              Restore
            </button>
          </>
        )}
        <button
          type="button"
          className="rewind__cancel"
          onClick={() => setPreview(null)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="user-msg__action"
      aria-label="Restore files to this point"
      title="Restore files to this point"
      disabled={disabled || busy}
      onClick={() => void ask()}
    >
      <IconHistory size={13} />
    </button>
  );
}

const TimelineRow = memo(function TimelineRow({
  item,
  onOpenFile,
  onFork,
  forking,
  showActions,
  showModelTag,
  editingId,
  streaming,
  onEditMessage,
  onCancelEdit,
  onVersionChange,
  onRewindFiles,
  subagentChildren,
}: {
  item: TimelineItem;
  onOpenFile: (view: ToolFileView) => void;
  onFork: (item: Extract<TimelineItem, { kind: "assistant" }>) => void;
  forking: boolean;
  showActions: boolean;
  showModelTag: boolean;
  editingId?: string | null;
  streaming?: boolean;
  onEditMessage?: (item: Extract<TimelineItem, { kind: "user" }>) => void;
  onCancelEdit?: () => void;
  onVersionChange?: (
    item: Extract<TimelineItem, { kind: "user" }>,
    index: number,
  ) => void;
  onRewindFiles?: (
    timestamp: number,
    dryRun: boolean,
  ) => Promise<RewindFilesResult>;
  subagentChildren?: Map<string, Extract<TimelineItem, { kind: "tool" }>[]>;
}) {
  if (item.kind === "tool")
    return (
      <ToolCard
        item={item}
        onOpenFile={onOpenFile}
        children={subagentChildren?.get(item.id) ?? []}
      />
    );
  if (item.kind === "notice")
    return <div className={`notice notice--${item.tone}`}>{item.text}</div>;
  if (item.kind === "user") {
    const versions = item.versions;
    const versionIndex = item.versionIndex ?? 0;
    return (
      <article className="tl tl--user">
        <span className="tl__node" />
        <div className="tl--user__stack">
          <div
            className={`user-msg${editingId === item.id ? " is-editing" : ""}`}
          >
            {item.text}
          </div>
          <div className="user-msg__actions">
            <CopyButton
              text={item.text}
              label="Copy message"
              className="user-msg__action"
            />
            <button
              type="button"
              className="user-msg__action"
              aria-label="Edit and resend"
              title="Edit and resend"
              disabled={streaming}
              onClick={() => {
                if (editingId === item.id) {
                  onCancelEdit?.();
                  return;
                }
                onEditMessage?.(item);
              }}
            >
              <IconPencil size={13} />
            </button>
            <RewindFilesButton
              timestamp={item.timestamp}
              disabled={streaming}
              onRewindFiles={onRewindFiles}
            />
          </div>
          {versions && versions.length > 1 && (
            <div
              className="user-msg__versions"
              role="group"
              aria-label="Message versions"
            >
              <button
                type="button"
                aria-label="Previous version"
                disabled={versionIndex === 0}
                onClick={() => onVersionChange?.(item, versionIndex - 1)}
              >
                ‹
              </button>
              <span>
                {versionIndex + 1}/{versions.length}
              </span>
              <button
                type="button"
                aria-label="Next version"
                disabled={versionIndex >= versions.length - 1}
                onClick={() => onVersionChange?.(item, versionIndex + 1)}
              >
                ›
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className="tl tl--assistant">
      <span className={`tl__node${item.live ? " is-live" : ""}`} />
      <div>
        <RichText
          text={item.text
            .replace(/\s*\[DONE:\d+\]\s*/gi, " ")
            // Models end turns with trailing newlines and pre-wrap renders
            // them as real blank lines — the phantom gap between prose and
            // the rows below.
            .replace(/\s+$/, "")
            .replace(/^\s+/, "")}
          live={item.live}
        />
      </div>
      {item.kind === "assistant" &&
        !item.live &&
        showModelTag &&
        (item.provider || item.modelId) && (
          <div
            className="response-model-tag"
            title="Model that generated this reply, as tracked by the backend — not the model's own self-report."
          >
            {item.provider}
            {item.provider && item.modelId ? "/" : ""}
            {item.modelId}
          </div>
        )}
      {item.kind === "assistant" && !item.live && showActions && (
        <div className="response-actions" aria-label="Response actions">
          <CopyButton
            text={item.text.replace(/\s*\[DONE:\d+\]\s*/gi, " ")}
            label="Copy response"
            iconOnly
          />
          <button
            type="button"
            className={forking ? "is-busy" : undefined}
            aria-label="Fork response"
            title={forking ? "Forking response" : "Fork response"}
            disabled={forking}
            onClick={() => onFork(item)}
          >
            <IconFork />
          </button>
        </div>
      )}
    </article>
  );
});

type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
type ChatRow =
  | { kind: "item"; item: TimelineItem }
  | { kind: "summary"; id: string; items: ToolItem[] };

function isExpandableActivity(item: TimelineItem): item is ToolItem {
  if (item.kind !== "tool") return false;
  return !["edit", "write"].includes(item.name.toLowerCase());
}

function buildChatRows(items: TimelineItem[], streaming: boolean): ChatRow[] {
  const segments: TimelineItem[][] = [];
  let current: TimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "user" && current.length) {
      segments.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) segments.push(current);

  return segments.flatMap((segment, segmentIndex) => {
    const active = streaming && segmentIndex === segments.length - 1;
    if (active) return segment.map((item) => ({ kind: "item" as const, item }));

    const rows: ChatRow[] = [];
    let activity: ToolItem[] = [];
    const flushActivity = () => {
      if (activity.length) {
        rows.push({
          kind: "summary",
          id: `tool-summary-${activity[0]?.id ?? segmentIndex}`,
          items: activity,
        });
        activity = [];
      }
    };
    segment.forEach((item) => {
      if (isExpandableActivity(item)) {
        activity.push(item);
        return;
      }
      flushActivity();
      rows.push({ kind: "item", item });
    });
    flushActivity();
    return rows;
  });
}

function getResponseActionIds(
  items: TimelineItem[],
  streaming: boolean,
): Set<string> {
  const ids = new Set<string>();
  let segment: TimelineItem[] = [];
  const segments: TimelineItem[][] = [];
  for (const item of items) {
    if (item.kind === "user" && segment.length) {
      segments.push(segment);
      segment = [];
    }
    segment.push(item);
  }
  if (segment.length) segments.push(segment);

  segments.forEach((turn, index) => {
    if (streaming && index === segments.length - 1) return;
    const assistantIndex = turn.reduce(
      (last, item, itemIndex) => (item.kind === "assistant" ? itemIndex : last),
      -1,
    );
    if (assistantIndex < 0) return;
    if (turn.slice(assistantIndex + 1).some((item) => item.kind === "tool"))
      return;
    const response = turn[assistantIndex];
    if (response?.kind === "assistant") ids.add(response.id);
  });
  return ids;
}
