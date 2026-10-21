/* Board events in words, for the activity lists. How a name is shown (nameOf) and a run state is called (RUN_LABEL)
   come from the page, so they are passed in. */
import { esc, icon } from './util.js';

export function eventIcon(t) {
  if (t === 'lease.status') return 'activity';
  if (t === 'item.assigned') return 'user';
  if (t === 'item.unblocked') return 'sparkle';
  if (t === 'review.requested') return 'eye';
  if (t.startsWith('master')) return 'lock';
  if (t === 'digest.added') return 'news';
  if (t.startsWith('lease')) return 'clock';
  if (t.startsWith('attention')) return 'ask';
  if (t.startsWith('comment')) return 'msg';
  if (t === 'item.moved' || t === 'item.reordered') return 'move';
  if (t === 'item.archived') return 'archive';
  if (t === 'item.restored') return 'restore';
  if (t === 'item.created') return 'plus';
  if (t === 'schema.updated') return 'layers';
  return 'pencil';
}

export function describe(ev, html, nameOf, RUN_LABEL) {
  const b = (s) => (html ? `<b>${esc(s)}</b>` : s);
  const who = b(ev.actor?.name ? nameOf(ev.actor.name) : 'someone');
  const nb = (n) => b(nameOf(n));
  const id = ev.item?.id || ev.itemId || '';
  const fields = Object.keys(ev.changes || {}).map((k) => k.replace(/^(properties|fields)\./, '')).join(', ');
  switch (ev.type) {
    case 'item.created': return `${who} created ${b(id)}${html ? '' : ` · ${ev.item?.title}`}`;
    case 'item.updated': return `${who} changed ${b(id)} ${fields}`;
    case 'item.moved': return `${who} moved ${b(id)} → ${b(ev.item?.column || '')}${ev.delegated ? ' for you' : ''}`;
    case 'item.reordered': return `${who} reordered ${b(id)}`;
    case 'item.archived': return `${who} archived ${b(id)}`;
    case 'item.deleted': return `${who} deleted test ticket ${b(id)}`;
    case 'review.reviewer_assigned': return `${who} asked ${b(nameOf(ev.reviewer))} to review ${b(id)}${ev.again ? ' again' : ''}`;
    case 'review.reviewer_removed': return `${who} removed ${b(nameOf(ev.reviewer))} as reviewer of ${b(id)}`;
    case 'review.reviewed': return `${who} reviewed ${b(id)}: ${ev.verdict === 'ok' ? 'looks good ✓' : 'concerns ⚠'}`;
    case 'agent.managed': return `${who} changed ${b(nameOf(ev.agent))}: ${Object.keys(ev.changes || {}).map((k) => k.replace(/^profile\./, '')).join(', ')}${ev.delegated ? ' for you' : ''}`;
    case 'item.restored': return `${who} restored ${b(id)}`;
    case 'comment.added': return `${who} on ${b(id)}: ${html ? esc(ev.comment?.body?.slice(0, 120)) : ev.comment?.body?.slice(0, 80)}${ev.comment?.attachments ? ` ${html ? icon('clip', 'sm') : '📎'}` : ''}`;
    case 'lease.claimed': return `${nb(ev.claimant)} claimed ${b(id)}`;
    case 'lease.renewed': return `${nb(ev.claimant)} renewed ${b(id)}`;
    case 'lease.released': return `${nb(ev.claimant)} released ${b(id)}`;
    case 'lease.requested': return `${who} asks ${nb(ev.claimant)} for ${b(id)}${ev.reason ? `: ${html ? esc(ev.reason) : ev.reason}` : ''}`;
    case 'lease.handed': return `${nb(ev.from)} handed ${b(id)} to ${nb(ev.claimant)}${ev.note ? `: ${html ? esc(ev.note) : ev.note}` : ''}`;
    case 'lease.declined': return `${who} declined ${nb(ev.requester)}'s request for ${b(id)}${ev.reason ? `: ${html ? esc(ev.reason) : ev.reason}` : ''}`;
    case 'lease.revoked': return `${who} revoked ${nb(ev.claimant)}'s lease on ${b(id)}`;
    case 'lease.warning': return `${nb(ev.claimant)}'s lease on ${b(id)} ends in ${ev.minutesLeft}m`;
    case 'lease.expired': return `${nb(ev.claimant)}'s lease on ${b(id)} expired`;
    case 'attention.raised': return `${who} needs you on ${b(id)}`;
    case 'attention.resolved': return `${who} answered ${b(id)}`;
    case 'column.created': return `${who} added column ${b(ev.column?.name || '')}${ev.delegated ? ' for you' : ''}`;
    case 'column.updated': return `${who} updated column ${b(ev.column?.name || '')}${ev.delegated ? ' for you' : ''}`;
    case 'column.deleted': return `${who} deleted column ${b(ev.column?.name || ev.columnId || '')}${ev.delegated ? ' for you' : ''}`;
    case 'schema.updated': return `${who} changed the ticket schema${ev.delegated ? ' for you' : ''}`;
    case 'board.updated': return `${who} updated the board${ev.delegated ? ' for you' : ''}`;
    case 'board.external-edit': return 'Board file changed on disk';
    case 'lease.status': return `${nb(ev.claimant)} on ${b(id)}: ${html ? esc(ev.status || '—') : ev.status || '—'}`;
    case 'item.assigned': return `${who} assigned ${b(id)} to ${b(ev.assignee || 'nobody')}`;
    case 'agent.run.started': return `${b(ev.agent)} woke up${ev.items?.length ? ` for ${ev.items.map(b).join(', ')}` : ''}`;
    case 'agent.run.finished': return ev.code === 0 ? `${b(ev.agent)} finished a run` : `${b(ev.agent)}'s run failed (${ev.code}) — retrying`;
    case 'agent.failed': return `${b(ev.agent)} keeps failing — paused until you resume it`;
    case 'agent.status': return `${b(ev.agent)} is ${RUN_LABEL[ev.status] || ev.status}`;
    case 'agents.changed': return ev.error ? `agents.json: ${ev.error}` : 'Standing agents updated';
    case 'master.claimed': return `${b(ev.holder)} is holding the whole board`;
    case 'master.renewed': return `${b(ev.holder)} renewed the board hold`;
    case 'master.released': return `${b(ev.holder)} released the board`;
    case 'master.revoked': return `${who} revoked ${b(ev.holder)}'s board hold`;
    case 'master.expired': return `${b(ev.holder)}'s board hold expired`;
    case 'master.status': return `${b(ev.holder)}: ${html ? esc(ev.status || '—') : ev.status || '—'}`;
    case 'review.requested': return `${who} asked you to review ${b(id)}`;
    case 'reaction.added': return `${who} reacted ${ev.emoji} on ${b(id)}`;
    case 'reaction.removed': return `${who} removed ${ev.emoji} on ${b(id)}`;
    case 'request.created': return `${who} asked ${b(ev.request?.to)}: ${html ? esc(String(ev.request?.body || '').slice(0, 80)) : String(ev.request?.body || '').slice(0, 80)}`;
    case 'request.replied': return `${who} replied to a request${ev.reply ? `: ${html ? esc(ev.reply.slice(0, 80)) : ev.reply.slice(0, 80)}` : ''}`;
    case 'request.done': return `${who} finished a request${ev.reply ? `: ${html ? esc(ev.reply.slice(0, 80)) : ev.reply.slice(0, 80)}` : ''}`;
    case 'review.approved': return `${who} approved ${b(id)}${ev.delegated ? ' for you' : ''}`;
    case 'review.changes_requested': return `${who} sent ${b(id)} back${ev.delegated ? ' for you' : ''}${ev.feedback ? `: ${html ? esc(ev.feedback) : ev.feedback}` : ''}`;
    case 'digest.added': return `${who} posted to the digest`;
    case 'item.unblocked': return `${b(id)} is unblocked (${b(ev.resolvedBy)} done)`;
    case 'app.renamed': return `${who} renamed the app to ${b(ev.to)}`;
    default: return `${who} · ${ev.type}`;
  }
}
