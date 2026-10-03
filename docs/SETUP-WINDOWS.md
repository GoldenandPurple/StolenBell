# Setting up Stolen Bell tip-out on a Windows computer

This sets up Claude on the GM's Windows computer so that saying **"run tip-out for yesterday"** pulls the day from Toast, works out everyone's tips, and hands back a filled-in Cash Out form.

It's a one-time setup of about 30 minutes. Do it in this order. The first half uses **demo data**, so you can check everything works before connecting the real Toast account.

You'll need:

- the Windows computer the GM will use, with an internet connection;
- the GM's Claude account (a paid plan);
- access to the `goldenandpurple/StolenBell` repository on GitHub;
- the file **`stolen-bell-tipout.zip`** (the skill);
- later, for step 7: Toast API credentials.

> Menu names in Claude and Toast change from time to time. If something isn't exactly where this guide says, look for the closest match.

---

## 1. Install Claude Desktop

1. Go to **https://claude.ai/download** and download Claude for Windows.
2. Run the installer and sign in with the GM's Claude account.
3. In Claude, open **Settings → Capabilities** and turn on **Code execution and file creation**. The tip-out skill needs this to do its maths and fill in the form.

## 2. Install Node.js

Node.js is what runs the Toast connection on this computer.

1. Go to **https://nodejs.org** and download the **LTS** version for Windows (the `.msi` installer).
2. Run it and accept all the default options.
3. Check it worked. Press the **Windows key**, type **cmd**, and open **Command Prompt**. Type this and press Enter:

   ```
   node -v
   ```

   You should see a version number such as `v22.11.0`. It must start with `v20` or higher. If you get *"'node' is not recognized"*, restart the computer and try again.

## 3. Download the Toast connection

1. In a web browser, open the repository on GitHub: **https://github.com/goldenandpurple/StolenBell**.
2. Make sure the branch dropdown (top left of the file list) says **`main`**.
3. Click the green **Code** button, then **Download ZIP**.
4. Open your **Downloads** folder, right-click the ZIP, and choose **Extract All…**.
5. Move the extracted folder to **`C:\StolenBell`**, so that a file exists at `C:\StolenBell\package.json`.

   GitHub sometimes nests the folder, e.g. `StolenBell-main\StolenBell-main\`. If so, move the *inner* folder, the one that has `package.json` directly inside it.

## 4. Build it

1. Open **Command Prompt** again (Windows key → type **cmd**). Use Command Prompt, not PowerShell; PowerShell can block the next commands.
2. Run these three commands, one at a time:

   ```
   cd C:\StolenBell
   npm install
   npm run build
   ```

   `npm install` takes a minute or two and prints a lot of text. Warnings are fine; a line containing **`ERR!`** is not, so see Troubleshooting if you get one.
3. Check that the file `C:\StolenBell\dist\index.js` now exists.

## 5. Connect it to Claude (demo data first)

1. In Claude Desktop, open **Settings → Developer** and click **Edit Config**. This opens the folder containing **`claude_desktop_config.json`**. Open that file in **Notepad**.
2. Replace everything in the file with this:

   ```json
   {
     "mcpServers": {
       "toast": {
         "command": "node",
         "args": ["C:/StolenBell/dist/index.js"],
         "env": {
           "TOAST_MCP_MODE": "demo"
         }
       }
     }
   }
   ```

   If the file already had other entries under `mcpServers`, keep them and add the `"toast": { … }` block alongside them, with a comma between entries.

   Use forward slashes (`C:/StolenBell/...`) exactly as shown. Backslashes need doubling in this file and are easy to get wrong.
3. Save the file.
4. **Fully quit Claude.** Closing the window isn't enough: right-click the Claude icon in the system tray (bottom-right, near the clock; you may need the **^** arrow), choose **Quit**, then open Claude again.
5. Back in **Settings → Developer**, **toast** should be listed as running.

**Check it:** start a new chat and type:

> Use the toast tools to show me the restaurant setup.

Claude should reply with a restaurant called **"Stolen Bell (demo data)"**, its job titles, and the tip-out settings. If it says it has no such tools, see Troubleshooting.

## 6. Add the tip-out skill

1. In Claude, open **Settings → Capabilities**, find **Skills**, and choose **Upload skill**.
2. Select **`stolen-bell-tipout.zip`**. Don't unzip it first.
3. Make sure the skill is switched **on**.

**Check it with demo data:** start a new chat and type:

> Run tip-out for 2026-09-26. Lunch cash was $42, dinner cash was $118.50.

Claude should show Lunch and Dinner, the kitchen lump, support and bar/server payouts, and offer a **Cash Out form** to download with a Lunch sheet and a Dinner sheet. These are made-up people and numbers.

## 7. Switch to the real Toast account

### Get Toast credentials

Someone with admin access to Toast does this once:

1. Sign in to **Toast Web**.
2. Go to **Integrations → Toast API access** (it may be under **Manage credentials**).
3. Create a new set of credentials with **read-only** access to **Labor**, **Orders**, **Configuration** and **Restaurants**.
4. Write down these four things:
   - the **API access URL** Toast shows (for example `https://ws-api.toasttab.com`);
   - the **Client ID**;
   - the **Client secret**. Treat it like a password: don't email it or paste it into a chat;
   - the restaurant's **location GUID**, a long code like `a1b2c3d4-…`.

### Put them in the config

1. Open `claude_desktop_config.json` again (**Settings → Developer → Edit Config**).
2. Replace the `"env"` section so the whole file looks like this, with your values in place of the `PASTE-…` text:

   ```json
   {
     "mcpServers": {
       "toast": {
         "command": "node",
         "args": ["C:/StolenBell/dist/index.js"],
         "env": {
           "TOAST_MCP_MODE": "live",
           "TOAST_API_ACCESS_URL": "PASTE-THE-API-ACCESS-URL",
           "TOAST_CLIENT_ID": "PASTE-THE-CLIENT-ID",
           "TOAST_CLIENT_SECRET": "PASTE-THE-CLIENT-SECRET",
           "TOAST_RESTAURANT_GUID": "PASTE-THE-LOCATION-GUID"
         }
       }
     }
   }
   ```

   Keep the quotation marks around each value.
3. Save, then **fully quit Claude and reopen it**, as in step 5.

The secret is now stored in this file on this computer, under the GM's Windows login. Only people who can sign in to that Windows account can read it.

**Check it:** in a new chat, ask:

> Use the toast tools to show me the restaurant setup.

This time you should see the real restaurant name. Check two things in the reply:

- **Unmapped jobs** should be empty. If a Toast job is listed there, send its exact name to whoever maintains the setup so it can be added to `config/tipout.yaml`.
- The **sales categories** should include **Food**. If the food category is called something else in Toast, that needs updating in `config/tipout.yaml` too.

## 8. Check it against Steph's sheets before paying from it

For the first week or two, run tip-out for days Steph has already done by hand and compare:

> Run tip-out for [a recent date]. Lunch cash was $__, dinner cash was $__.

Use the same cash counts Steph used. Compare the kitchen lump, support total and each person's payout with her sheet. Small differences in hours usually come from edited punches in Toast; Claude will mention these. Bigger differences need looking into before anyone is paid from the new process.

---

## Everyday use

1. Open Claude Desktop.
2. Type something like: **"Run tip-out for yesterday. Lunch cash $35, dinner cash $142."**
3. If Claude says it **can't continue**, it will say why: for example someone is still clocked in, or a Toast job isn't mapped. Fix it in Toast (or tell the person who maintains the setup), then ask again.
4. Review the numbers and the flags, then download the Cash Out form.

Nothing is paid and nothing is changed in Toast. The form is a draft for the GM to check and act on.

## Updating to a new version

1. Download the ZIP again (step 3) and extract it over `C:\StolenBell`, replacing files.
2. In Command Prompt: `cd C:\StolenBell`, then `npm install`, then `npm run build`.
3. Fully quit and reopen Claude.
4. If you were sent a new `stolen-bell-tipout.zip`, upload it in **Settings → Capabilities → Skills**, replacing the old one.

`config/tipout.yaml` will be overwritten by the download, so any change made to it on this computer should also be made in the GitHub repository.

## Troubleshooting

**Claude says it doesn't have the toast tools**
- Check **Settings → Developer**: is **toast** listed, and does it show an error?
- Make sure you fully quit Claude from the system tray, not just closed the window.
- Open the config file and check the JSON. A missing comma or quotation mark breaks the whole file. You can paste it into **https://jsonlint.com** to find the problem. Don't paste it there once it contains the client secret.
- The log is at `%APPDATA%\Claude\logs\mcp-server-toast.log`. Paste that into File Explorer's address bar to open it.

**The log says `node` isn't found, or `spawn node ENOENT`**
Restart the computer after installing Node.js. If it still fails, replace `"command": "node"` with the full path, written exactly like this:
`"command": "C:\\Program Files\\nodejs\\node.exe"`

**The log says `Cannot find module 'C:\StolenBell\dist\index.js'`**
Step 4 didn't finish, or the folder is in a different place. Check the file exists, and that the path in the config matches.

**`npm` gives an error about running scripts being disabled**
You're in PowerShell. Open **Command Prompt** instead (Windows key → **cmd**).

**"Live mode requires …"**
One of the four Toast values is missing from the config. Check the spelling of each name in step 7.

**Toast API request failed with HTTP 401 or 403**
The credentials are wrong, or don't have read access to Labor, Orders, Configuration and Restaurants. Check them in Toast Web.

**Tip-out stops with "isn't mapped to a tip-out role"**
Toast has a job title the setup doesn't know yet. Add it to `config/tipout.yaml` in the repository with the role it should have, then update this computer.
