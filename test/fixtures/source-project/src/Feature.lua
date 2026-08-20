---@ymai-side client
local Feature = {}

local retry = 3
local config = { buttonId = 41001 }

function Feature.Refresh()
    UI:SetText(41001, "经验")
    Event:Send("round_started")
end

function Feature.Listen()
    Event:Listen("round_started", Feature.Refresh)
end

return Feature
