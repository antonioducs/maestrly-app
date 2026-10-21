# Connect your computers

Use Maestrly on your other computers from this one, and this one from them. A paired computer shows in the machine
switcher at the top of the sidebar, next to **This computer**: its chats and workspaces run there, with its folders,
terminals, accounts, and keys. The connection goes straight from one computer to the other, over your local network or
[Tailscale](https://tailscale.com), encrypted; no server or account sits in between.

## Set up

Both computers must run the same version of Maestrly.

1. On the computer you want to use from elsewhere, open **Settings → Computers** and turn on **Let my other computers
   use this computer**. It lists the addresses it can be reached at, such as `192.168.1.20` or `studio.local`, and a
   port when it is not the default, `7690`.
2. On the other computer, open **Settings → Computers** and choose **Connect a computer…**, or choose **Connect another
   computer…** at the bottom of the machine switcher. Type one of those addresses: an IP address, a `.local` name, or
   the computer's Tailscale name, followed by `:port` when the first computer showed one.
3. The first computer shows a 6-digit code. Type it on the second one. The code is valid for 2 minutes and for one try;
   a wrong or expired code ends the pairing on both computers, and **Ask for a new code** starts again.

If the first computer is not in front of you when the code appears, it also shows a system notification. Only type a
code you asked for: the first computer's dialog warns that a paired computer can use everything on it.

One pairing works both ways. Each computer can use the other while that one has **Let my other computers use this
computer** turned on. A computer that does not share itself still uses the other one, and appears in the other's
machine switcher once it shares itself.

Each computer is listed under the name it has in **This computer's name**, in **Settings → Computers**. A new name
reaches the other computers the next time they connect.

## Use a paired computer

Choose the computer in the machine switcher. Its chats and workspaces, a conversation's terminals, **Files**, and
**Code** work as they do for a [workspaces environment](remote-workspaces.md): they run on that computer, and its
folders are the ones you browse. A conversation's **Browser** opens on a computer running macOS or Windows; on a Linux
computer it is not available yet. A conversation's **Computer** tab is not available on a paired computer.

While another computer uses this one, **In use by** shows at the bottom of this computer's sidebar. It lists each
connected computer and since when, with **Disconnect**. While a computer is connected, this one does not go to sleep on
its own.

## Disconnect and remove

- **Disconnect**, in the **In use by** menu or in **Settings → Computers**, ends what the other computer has open on
  this one. They stay paired: the other computer shows **Disconnected** with **Reconnect**, and does not connect again
  on its own.
- **Remove**, in **Settings → Computers**, forgets the other computer at once. Its sessions on this computer close and
  its access stops working. This computer also asks the other one to forget it. When the other computer cannot answer,
  because it is off or does not share itself, it shows **Removed this computer** instead, with **Pair again** and
  **Remove**.
- Turning off **Let my other computers use this computer** closes every session other computers have on it. They stay
  paired.

## Connection states

The machine switcher shows a paired computer with a laptop icon and one of these states:

| State | Meaning | What to do |
| --- | --- | --- |
| **Online**, or what its conversations are doing | Connected. | — |
| **Connecting…** or **Reconnecting…** | The connection is being opened, or dropped and is being opened again. Work on that computer continues. | Wait, or use **Try again**. |
| **Not connected** | The computer is asleep, off, or out of reach. | Wake it. Away from home, both computers need Tailscale. |
| **Not shared** | The computer is reachable but does not let other computers use it now, or listens on another port than the one this computer knows. | Turn on **Let my other computers use this computer** on it. If its port changed while this computer was off, pair again with its new address. |
| **Disconnected** | The computer disconnected this one. They stay paired. | **Reconnect**. |
| **Removed this computer** | The computer removed this one. | **Pair again**, or **Remove** it here. |
| **Pair again** | The computer answered with another identity than the one paired: it was reinstalled, or something sits in between. | Pair again, with a code shown on that computer. |
| **Update required** | The two computers run different versions of Maestrly. | Update the older one. |

## Network

The computers reach each other on TCP port `7690`. When another program holds that port, Maestrly takes one of the next
nine and shows it in **Settings → Computers**. Allow incoming connections to Maestrly in the computer's firewall when
it asks.

To use another port, open **Advanced** in **Settings → Computers**, type a port from 1024 to 65535, and choose **Use
port**; **Use the default port** goes back. A chosen port is used exactly: when another program holds it, nothing
changes and Settings says so. The paired computers keep the port they last knew. The ones connected when you change it
are told the new one and reconnect there; one that was off or asleep shows **Not shared**, and pairs again with the new
address, through **Connect a computer…**. For the same reason, a computer that had to take one of the next ports at
startup is out of reach of the others until it gets its own port back: choose a port under **Advanced** to keep it
fixed.

Some networks keep their devices apart, such as guest, hotel, or corporate Wi-Fi. Use Tailscale there: install it on
both computers and type the Tailscale name of the computer to use.

New pairings pause for 10 minutes after 3 wrong codes within 10 minutes, and a computer takes at most 5 pairing
requests a minute.

## Not available yet

- **Finding computers on the network.** Type the address the other computer shows.
- **The Browser on a Linux computer**, and a conversation's **Computer** tab on any paired computer.

## Security

A paired computer can do everything you can do on this one: read and change the files of your home folder, run
commands, and use your accounts, keys, and Git and SSH credentials. Pair only your own computers, and remove one you
lose. See the [security model](security-model.md#connected-computers) for how pairing and connections are protected,
and [local data](local-data.md#connected-computers) for what each computer keeps.
