--- 匿名界面模块，用于测试声明索引。
--- @module "UI"

---@class UI
local UI_module = {}

--- 获取控件名称。
---@param WidgetId number -- 控件 ID
---@return string name -- 控件名称
function UI_module:GetUIName(WidgetId) end

--- 设置控件显隐。
---@param WidgetId number -- 控件 ID
---@param Visible boolean -- 是否显示
function UI_module:SetVisible(WidgetId, Visible) end

_G.UI = UI_module
