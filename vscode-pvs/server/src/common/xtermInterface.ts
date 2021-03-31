export enum XTermEvent {
    sendText = "sendText",
    DidCloseTerminal = "DidCloseTerminal",
};
export enum XTermCommands {
    write = "write",
    log = "log",
    focus = "focus",
    showPrompt = "showPrompt",
    updateHints = "updateHints",
    updateMathObjects = "updateMathObjects",
    clearScreen = "clearScreen",
    disableInput = "disableInput",
    enableInput = "enableInput",
    updateCommandHistory = "updateCommandHistory",
    updateHelp = "updateHelp",
    clearCommandLine = "clearCommandLine",
    showWelcomeMessage = "showWelcomeMessage"
};

export interface UpdateCommandHistoryData { cmd: string, successHistory?: boolean }

export const interruptCommand: string = "ctrl+c";

export declare type SessionType = "prover" | "evaluator";