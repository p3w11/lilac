#pragma semicolon 1
/* =========================================================
   FLUX Bridge — мост между порталом и игровым сервером.

   Позволяет выдавать и снимать права на сервере командой с портала
   (портал шлёт их по RCON). Команды консоли:

       flx_grant  <steamid> [ник] [флаги]
       flx_revoke <steamid>

   Пример:  flx_grant "STEAM_0:1:12345678" "flx_player" "b"

   Флаги: a/b — generic, c — kick, d — ban, e — slay, f — смена карты,
          g — чат, h — голоса.

   Требуется SourceMod 1.12+ (нативы CreateAdmin / BindIdentity /
   SetFlag / FindAdminByIdentity).

   Установка:  addons/sourcemod/plugins/flx_bridge.smx
   ========================================================= */
#include <sourcemod>
#include <admin>
#include <console>

public Plugin myinfo =
{
    name    = "FLUX Bridge",
    author  = "FLUX HvH",
    version = "1.0.0"
};

public void OnPluginStart()
{
    RegConsoleCmd("flx_grant",  CmdGrant,  "Выдать права игроку по SteamID: flx_grant <steamid> [ник] [флаги]");
    RegConsoleCmd("flx_revoke", CmdRevoke, "Снять права игрока по SteamID: flx_revoke <steamid>");
    PrintToServer("[FLUX] Мост готов. Команды: flx_grant, flx_revoke");
}

/* ---------------- выдача ---------------- */
public Action CmdGrant(int client, int args)
{
    if (args < 1)
    {
        Reply(client, "flx_grant <steamid> [ник] [флаги]");
        return Plugin_Handled;
    }

    char steamid[64];
    char name[64];
    char flags[32] = "b";
    GetCmdArg(1, steamid, sizeof(steamid));
    if (args >= 2) GetCmdArg(2, name, sizeof(name));
    if (args >= 3) GetCmdArg(3, flags, sizeof(flags));
    if (name[0] == '\0') Format(name, sizeof(name), "%s", steamid);

    // если такой SteamID уже есть — переиспользуем запись
    AdminId id = FindAdminByIdentity("STEAM", steamid);
    if (id == INVALID_ADMIN_ID)
    {
        id = CreateAdmin(name);
        if (id == INVALID_ADMIN_ID)
        {
            Reply(client, "не удалось создать админа");
            return Plugin_Handled;
        }
        if (!id.BindIdentity("STEAM", steamid))
        {
            Reply(client, "не удалось привязать SteamID");
            return Plugin_Handled;
        }
    }
    else
    {
        // обновляем имя
        AdminId fresh = CreateAdmin(name);
        if (fresh != INVALID_ADMIN_ID)
        {
            fresh.BindIdentity("STEAM", steamid);
            SetFlags(fresh, flags);
            ReplyOk(client, steamid, name);
            return Plugin_Handled;
        }
    }

    SetFlags(id, flags);
    ReplyOk(client, steamid, name);
    return Plugin_Handled;
}

/* ---------------- снятие ---------------- */
public Action CmdRevoke(int client, int args)
{
    if (args < 1)
    {
        Reply(client, "flx_revoke <steamid>");
        return Plugin_Handled;
    }

    char steamid[64];
    GetCmdArg(1, steamid, sizeof(steamid));

    AdminId id = FindAdminByIdentity("STEAM", steamid);
    if (id == INVALID_ADMIN_ID)
    {
        char err[160];
        Format(err, sizeof(err), "не найден админ с SteamID %s", steamid);
        Reply(client, err);
        return Plugin_Handled;
    }

    RemoveAdmin(id);

    char ok[160];
    Format(ok, sizeof(ok), "права сняты: %s", steamid);
    Reply(client, ok);
    PrintToServer("[FLUX] %s", ok);
    return Plugin_Handled;
}

/* ---------------- вспомогательное ---------------- */
void SetFlags(AdminId id, const char[] flags)
{
    bool any = false;
    for (int i = 0; i < strlen(flags); i++)
    {
        char f = flags[i];
        if (f == 'a' || f == 'b') { id.SetFlag(Admin_Generic, true);   any = true; }
        else if (f == 'c')        { id.SetFlag(Admin_Kick, true);      any = true; }
        else if (f == 'd')        { id.SetFlag(Admin_Ban, true);       any = true; }
        else if (f == 'e')        { id.SetFlag(Admin_Slay, true);      any = true; }
        else if (f == 'f')        { id.SetFlag(Admin_Changemap, true); any = true; }
        else if (f == 'g')        { id.SetFlag(Admin_Chat, true);      any = true; }
        else if (f == 'h')        { id.SetFlag(Admin_Vote, true);      any = true; }
    }
    if (!any) id.SetFlag(Admin_Generic, true);
}

void ReplyOk(int client, const char[] steamid, const char[] name)
{
    char ok[160];
    Format(ok, sizeof(ok), "выданы права: %s (%s)", steamid, name);
    Reply(client, ok);
    PrintToServer("[FLUX] %s", ok);
}

void Reply(int client, const char[] msg)
{
    if (client == 0) PrintToServer("%s", msg);
    else ReplyToCommand(client, "%s", msg);
}
