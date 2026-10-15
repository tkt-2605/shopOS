# Other tills cannot reach this one (Windows network prompt)

**Symptom.** "The second till can't find the main." Or: "Adding a till never finishes." Or: "Sync says the main is out of reach, but it's on."

**Confirm.**
- In the health report from the counter, the main's peer row has a `last_error` of a connection refused or timed out, and `last_agreed_at` is old or empty.
- The main's own report shows the counter never asked.

**Why it happens.** The first time a till opens its port, Windows asks whether ShopOS may use the network, and only an administrator can say yes. On a PC signed in as an ordinary user the question is refused, or goes unanswered, and nothing in ShopOS can see that.

**Fix.**
1. Have whoever set up the PC sign in to Windows as an administrator, open ShopOS on the main till, and choose **Allow** when Windows asks. Windows remembers.
2. If the question never appears: Windows Security → Firewall & network protection → Allow an app through firewall. Tick ShopOS for **Private** networks.
3. Check that the shop's network is set to **Private**, not **Public**, in Windows network settings. On Public, Windows blocks it however the app is set.
4. Check that both tills are on the same router. A guest Wi-Fi often keeps devices from seeing each other.
5. Third-party antivirus (Quick Heal, K7 and the like) has its own firewall: allow ShopOS there too.

**Escalate.** All of the above is done and a browser on the counter still cannot open `http://<main's IP>:<port>/` (the port is on the main's Add a till panel).
