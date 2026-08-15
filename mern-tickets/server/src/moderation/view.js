export function canSeeModerationDetail(subject) {
  return subject.role === 'agent' || subject.role === 'admin'
}

export function viewModeratable(doc, subject) {
  const json = doc.toJSON()
  if (canSeeModerationDetail(subject)) return json
  return { ...json, moderation: { flagged: json.moderation.flagged } }
}
