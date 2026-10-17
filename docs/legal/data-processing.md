# Data processing agreement

> DRAFT for review by a lawyer before any shop signs it. Written against the
> Digital Personal Data Protection Act, 2023 and its Rules. The bracketed
> parts are the vendor's to fill in. The figures below are the ones the code
> enforces; `privacy-notice.md` says the same to the owner in plain words.

Between **the shop** named on its ShopOS account (the *Data Fiduciary*), and
**[Vendor legal name]**, of [address] (*ShopOS*, the *Data Processor*).

## 1. What this covers

The shop collects personal data from its own customers: names, phone
numbers, email addresses, GSTINs and addresses, and what they bought and
owe. The shop decides why and how. ShopOS processes that data for the shop
only in these cases:

| Case | What ShopOS receives | Why | Kept |
|---|---|---|---|
| The owner sends the shop's records to support | The shop's database, encrypted on the till to ShopOS's key; customer details left out unless the owner includes them | To find and fix a fault the shop reported | Deleted 30 days after it arrives; 7 days for an upload that never finished |
| Remote help | What is on the screen, while someone at the shop runs a session they started | To find and fix a fault the shop reported | Not recorded |
| A fix from support | Nothing; the fix is applied by the owner on the till | To correct records the shop asked to have corrected | — |
| The Cloud plan, when taken | A copy of the shop's database on ShopOS's server | To sync the shop's tills and show the owner the shop on a phone | While the plan runs; read-only for 90 days after it ends, then deleted |

The daily health report holds no personal data (counts, error kinds, sync
state, licence state) and is outside this agreement; the privacy notice
covers it.

## 2. ShopOS's obligations

ShopOS shall:

1. process the shop's personal data only for the purposes in section 1, and on the shop's documented instructions;
2. not sell it, not use it to contact the shop's customers or for advertising, and not disclose it except as the law requires, telling the shop first where the law allows;
3. keep it secure, at the least by:
   - encrypting data sent to support on the shop's till, to a key held offline and never on a server;
   - signing every fix and switch board it sends with a key held offline, so a till refuses one that did not come from ShopOS;
   - giving each person at ShopOS who does support their own sign-in, with a role that limits what they may open;
   - recording every look at a shop's data and every download, and showing the shop that record on request;
4. make sure everyone at ShopOS who can see the data is bound to keep it confidential;
5. tell the shop without delay, and within 72 hours of becoming aware, of any breach affecting its data, with what is known of it, so the shop can meet its own duty to notify the Data Protection Board and its customers;
6. help the shop answer a request from one of its customers to see, correct or erase their data, where the data is held by ShopOS;
7. delete the data at the end of the periods in section 1, and on the shop's written request where no law requires it be kept, and confirm the deletion.

## 3. Others who process for ShopOS

ShopOS uses these, each bound to protect the data as this agreement requires:

| Who | For | Personal data they can see |
|---|---|---|
| [VPS provider], servers in India | Running the portal and, on the Cloud plan, the shop's copy | Encrypted support uploads; on Cloud, the shop's copy |
| [Object storage provider] | Nightly copies of the portal for recovery | As above |
| Telegram (Gateway) | Sending sign-in codes to owners | The owner's phone number |

ShopOS will tell the shop before adding another, and the shop may object.

## 4. The shop's obligations

The shop is responsible to its customers for their data: for having a lawful reason to collect it, for telling them, and for answering them. It shall not send ShopOS more than a fault needs, and should leave customer details out of data sent to support unless the fault is about them.

## 5. Term

This agreement runs while the shop uses ShopOS, and its duties of confidentiality and deletion continue after.

Signed for the shop: ____________________   Date: __________

Signed for ShopOS: ____________________   Date: __________
