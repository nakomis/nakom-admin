"""Real token counts for the 'just throw it at an LLM' baseline."""
import psycopg

PROMPT_OVERHEAD = 90   # instruction + labels, measured from the prompt below
CHARS_PER_TOKEN = 3.6  # conservative for mixed code/prose

with psycopg.connect("postgres://claude:claude@172.29.0.30:5432/claude_chats") as c, c.cursor() as cur:
    cur.execute("SELECT count(*), sum(length(content)) FROM messages WHERE embedding IS NOT NULL")
    n_all, chars_all = cur.fetchone()
    cur.execute("SELECT count(*), sum(length(content)) FROM messages WHERE embedding IS NOT NULL AND role='user'")
    n_user, chars_user = cur.fetchone()

for label, n, ch in (("whole corpus", n_all, chars_all), ("user-role only", n_user, chars_user)):
    # Truncating to 800 chars is what you'd actually do; charge for that.
    tok_in = int(n * PROMPT_OVERHEAD + min(ch, n * 800) / CHARS_PER_TOKEN)
    tok_out = n * 3
    print(f"\n{label}: {n:,} messages, {ch/1e6:.1f}M chars")
    print(f"  input ~{tok_in/1e6:.2f}M tokens, output ~{tok_out/1e6:.2f}M tokens")
    for model, pin, pout in [
        ("frontier tier   ($3/$15 per Mtok)", 3.00, 15.00),
        ("mid tier        ($0.80/$4)",        0.80,  4.00),
        ("small/batch     ($0.25/$1.25)",     0.25,  1.25),
    ]:
        usd = tok_in/1e6*pin + tok_out/1e6*pout
        print(f"    {model}: ${usd:,.2f}  (~£{usd*0.79:,.2f})")
