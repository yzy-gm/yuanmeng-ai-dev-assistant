--- 匿名界面模块第二版，用于测试声明差异。
--- @module "UI"

---@class UI
local UI_module = {}

--- 获取控件名称。
---@param WidgetId number -- 控件 ID
---@param Locale string -- 语言
---@return number name -- 控件名称编号
function UI_module:GetUIName(WidgetId, Locale) end

--- 设置控件文字。
---@param WidgetId number -- 控件 ID
---@param Text string -- 新文字
function UI_module:SetText(WidgetId, Text) end

_G.UI = UI_module
