<?xml version="1.0" encoding="UTF-8"?>
<Project Type="Project" LVVersion="25008000">
  <Property Name="NI.Project.Description" Type="Str">隧途明鉴：LabVIEW 上位机与本机智能检测服务集成工程</Property>
  <Item Name="My Computer" Type="My Computer">
    <Property Name="server.app.propertiesEnabled" Type="Bool">true</Property>
    <Property Name="server.vi.callsEnabled" Type="Bool">true</Property>
    <Property Name="server.vi.propertiesEnabled" Type="Bool">true</Property>
    <Item Name="Main.vi" Type="VI" URL="Main.vi"/>
    <Item Name="配置与脚本" Type="Folder">
      <Item Name="config.json" Type="Document" URL="config.json"/>
      <Item Name="启动隧道检测.ps1" Type="Document" URL="启动隧道检测.ps1"/>
      <Item Name="停止隧道检测.ps1" Type="Document" URL="停止隧道检测.ps1"/>
      <Item Name="检查系统.ps1" Type="Document" URL="检查系统.ps1"/>
      <Item Name="运行LabVIEW主程序.vbs" Type="Document" URL="运行LabVIEW主程序.vbs"/>
    </Item>
    <Item Name="文档" Type="Folder">
      <Item Name="README.md" Type="Document" URL="README.md"/>
      <Item Name="API接口清单.md" Type="Document" URL="API接口清单.md"/>
    </Item>
    <Item Name="Dependencies" Type="Dependencies"/>
    <Item Name="Build Specifications" Type="Build"/>
  </Item>
</Project>
