import type { DcpCommand, TuiApi } from "./types"

export function registerCommands(api: TuiApi, commands: DcpCommand[]) {
    const keymap = (api as any).keymap
    if (keymap?.registerLayer) {
        keymap.registerLayer({
            commands: commands.map((command) => ({
                namespace: "palette",
                name: command.name,
                title: command.title,
                desc: command.description,
                category: "DCP",
                slashName: command.slashName,
                slashAliases: command.slashAliases,
                run: command.run,
            })),
        })
        return
    }

    api.command?.register(() =>
        commands.map((command) => ({
            title: command.title,
            value: command.name,
            description: command.description,
            category: "DCP",
            slash: { name: command.slashName, aliases: command.slashAliases },
            onSelect: command.run,
        })),
    )
}
