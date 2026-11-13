// Example Agent Studio script hook.
// Export a default function (or a function named after the event).
// ctx = { event, agent, model, workspace, userText, replyText, sessionId, data }
// api = { remember(text, opts), note(text, opts), recall(query, limit), log(msg), config() }
// Return a string (or { inject: "..." }) from a beforeChat hook to add it to the system prompt.

export default async function (ctx, api) {
    if (ctx.event === 'afterChat' && /TODO/i.test(ctx.replyText || '')) {
        api.note('Agent left TODOs in its last reply - follow up.', { sessionId: ctx.sessionId });
    }
    api.log(`example hook fired for ${ctx.event} (agent: ${ctx.agent?.name || 'none'})`);
}
