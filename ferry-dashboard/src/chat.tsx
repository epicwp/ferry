import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { agentHistory, agentNewSession, agentSend, ApiError, type AgentWireEvent } from './api';
import { InlineChangeCard } from './change-parts';

type ConnState = 'connecting' | 'live' | 'lost';

interface ToolRow { toolUseId: string; name: string; input: string; output?: string; isError?: boolean }

type Block =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'agent'; key: string; text: string }
  | { kind: 'tools'; key: string; rows: ToolRow[] }
  | { kind: 'status'; key: string; text: string; isError?: boolean }
  | { kind: 'turn_end'; key: string; text: string }
  | { kind: 'change_card'; key: string; changeSeq: number; title: string; status: string };

const ERROR_SUBTYPES = new Set(['error_max_turns', 'error_max_budget_usd', 'error_during_execution']);

/** One tool call, collapsed to a single truncated line by default; the chevron expands it.
 *  A collapsed row is clickable anywhere (nothing to select there); once open, only the
 *  chevron toggles so the full input/output text stays selectable. */
function ToolRowView({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={open ? 'chat__toolrow chat__toolrow--open' : 'chat__toolrow'}
      onClick={() => { if (!open) setOpen(true); }}
    >
      <button
        type="button" className="chat__tool-chevron" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
      >
        {open ? '▾' : '▸'}
      </button>
      <span className="chat__tool-name">{row.name}</span>
      <span className="chat__tool-input">{row.input}</span>
      <span className={row.isError ? 'chat__tool-output chat__tool-output--error' : 'chat__tool-output'}>
        {row.output ?? '…'}
      </span>
    </div>
  );
}

/** Walk persisted events into renderable blocks, pairing tool_use/tool_result by toolUseId. */
function buildBlocks(events: AgentWireEvent[]): Block[] {
  const blocks: Block[] = [];
  let tools: ToolRow[] | null = null;
  let toolIndex = new Map<string, ToolRow>();
  const flushTools = () => {
    if (tools && tools.length > 0) blocks.push({ kind: 'tools', key: `tools-${blocks.length}`, rows: tools });
    tools = null;
    toolIndex = new Map();
  };

  events.forEach((event, i) => {
    const key = event.seq !== undefined ? `seq-${event.seq}` : `local-${i}`;
    switch (event.type) {
      case 'user':
        flushTools();
        blocks.push({ kind: 'user', key, text: String(event.payload.text ?? '') });
        break;
      case 'agent_text':
        flushTools();
        blocks.push({ kind: 'agent', key, text: String(event.payload.text ?? '') });
        break;
      case 'tool_use': {
        if (!tools) tools = [];
        const row: ToolRow = {
          toolUseId: String(event.payload.toolUseId ?? ''),
          name: String(event.payload.name ?? ''),
          input: String(event.payload.input ?? ''),
        };
        tools.push(row);
        toolIndex.set(row.toolUseId, row);
        break;
      }
      case 'tool_result': {
        const row = toolIndex.get(String(event.payload.toolUseId ?? ''));
        if (row) {
          row.output = String(event.payload.output ?? '');
          row.isError = Boolean(event.payload.isError);
        }
        break;
      }
      case 'status':
        flushTools();
        blocks.push({
          kind: 'status', key,
          text: String(event.payload.detail ?? event.payload.state ?? ''),
          isError: event.payload.state === 'error',
        });
        break;
      case 'turn_end': {
        const subtype = String(event.payload.subtype ?? '');
        if (ERROR_SUBTYPES.has(subtype)) {
          flushTools();
          blocks.push({
            kind: 'turn_end',
            key,
            text: `The agent stopped (${subtype}). Send a message to continue, or start a new session.`,
          });
        }
        break;
      }
      case 'change_card':
        flushTools();
        blocks.push({
          kind: 'change_card', key,
          changeSeq: Number(event.payload.seq ?? 0), // the CHANGE seq, not the wire seq
          title: String(event.payload.title ?? ''),
          status: String(event.payload.status ?? ''),
        });
        break;
      default:
        break;
    }
  });
  flushTools();
  return blocks;
}

export function AgentChat({ siteId }: { siteId: number }) {
  const location = useLocation();
  const [events, setEvents] = useState<AgentWireEvent[]>([]);
  const [streamText, setStreamText] = useState('');
  const [conn, setConn] = useState<ConnState>('connecting');
  const [draft, setDraft] = useState(() => (location.state as { prefill?: string } | null)?.prefill ?? '');
  const navigate = useNavigate();
  // Issue #11: consume-and-clear — the prefill must not survive in history state,
  // or a reload re-seeds the composer with the stale message.
  useEffect(() => {
    if ((location.state as { prefill?: string } | null)?.prefill) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);
  const [sendError, setSendError] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const connect = useCallback(async () => {
    esRef.current?.close(); // close any prior connection first — native EventSource auto-retries otherwise, doubling live events
    setConn('connecting');
    setStreamText(''); // don't leave a stale in-flight bubble stuck if the turn finished while we were disconnected
    let history;
    try {
      history = await agentHistory(siteId);
    } catch {
      setConn('lost'); // history fetch failed — surface the visible lost state + Reconnect instead of hanging on 'connecting'
      return;
    }
    setEvents(history.events);
    const lastSeq = history.events.at(-1)?.seq ?? 0;
    const es = new EventSource(`/api/sites/${siteId}/agent/events?after=${lastSeq}`);
    esRef.current = es;
    es.onopen = () => setConn('live');
    es.onmessage = (ev) => {
      const event = JSON.parse(ev.data) as AgentWireEvent;
      if (event.type === 'text_delta') {
        setStreamText((t) => t + String(event.payload.text ?? ''));
        return;
      }
      if (event.type === 'agent_text') setStreamText(''); // authoritative text replaces the accumulation
      setEvents((prev) => (event.seq !== undefined && prev.some((p) => p.seq === event.seq) ? prev : [...prev, event]));
    };
    es.onerror = () => setConn('lost'); // 3b fold-in: the silent-freeze fix — visible state + retry button
  }, [siteId]);

  useEffect(() => {
    void connect();
    return () => esRef.current?.close();
  }, [connect]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [events, streamText]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (text === '') return;
    try {
      await agentSend(siteId, text); // optimistic render not needed: the 'user' event echoes over SSE
      setDraft('');
      setSendError('');
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send — try again.');
    }
  }

  async function newSession() {
    await agentNewSession(siteId);
    setEvents([]);
    setStreamText('');
    void connect(); // connect() now closes any prior EventSource itself
  }

  const blocks = buildBlocks(events);

  return (
    <main className="chat">
      <div className="chat__header">
        <span className="chat__title">Agent chat</span>
        <div className="chat__header-right">
          {conn === 'live' && (
            <span className="chat__conn chat__conn--live mono"><span className="chat__conn-dot" />SSE live</span>
          )}
          {conn === 'lost' && (
            <span className="chat__conn chat__conn--lost mono">
              connection lost
              <button type="button" className="chat__reconnect" onClick={connect}>Reconnect</button>
            </span>
          )}
          {conn === 'connecting' && <span className="chat__conn chat__conn--connecting mono">connecting…</span>}
        </div>
      </div>

      <div className="chat__body" ref={scrollRef}>
        {blocks.map((block) => {
          if (block.kind === 'user') {
            return <div key={block.key} className="chat__msg chat__msg--user">{block.text}</div>;
          }
          if (block.kind === 'agent') {
            return (
              <div key={block.key} className="chat__msg-group">
                <div className="chat__msg-head"><span className="chat__agent-mark" />Ferry agent</div>
                <div className="chat__msg chat__msg--agent">{block.text}</div>
              </div>
            );
          }
          if (block.kind === 'tools') {
            return (
              <div key={block.key} className="chat__toolblock mono">
                {block.rows.map((row) => <ToolRowView key={row.toolUseId} row={row} />)}
              </div>
            );
          }
          if (block.kind === 'change_card') {
            return (
              <InlineChangeCard
                key={block.key}
                siteId={siteId}
                changeSeq={block.changeSeq}
                title={block.title}
                status={block.status}
              />
            );
          }
          if (block.kind === 'status') {
            return (
              <div key={block.key} className={block.isError ? 'chat__status chat__status--error mono' : 'chat__status mono'}>
                {block.text}
              </div>
            );
          }
          return <div key={block.key} className="chat__status chat__status--error mono">{block.text}</div>;
        })}
        {streamText !== '' && (
          <div className="chat__msg-group">
            <div className="chat__msg-head"><span className="chat__agent-mark" />Ferry agent</div>
            <div className="chat__msg chat__msg--agent">{streamText}<span className="chat__caret" /></div>
          </div>
        )}
        {sendError !== '' && <div className="chat__status chat__status--error mono">{sendError}</div>}
      </div>

      <div className="chat__composer">
        <form className="chat__composer-bar" onSubmit={submit}>
          <input
            className="chat__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask a follow-up or request another fix…"
          />
          <span className="chat__composer-hint mono">wp-cli · git · shell</span>
          <button type="submit" className="chat__send" aria-label="Send message">↑</button>
        </form>
        <button type="button" className="chat__newsession" aria-label="Start a new session" onClick={newSession}>
          New session
        </button>
      </div>
    </main>
  );
}
