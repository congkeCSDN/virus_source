webpackJsonp([0],{8:function(t,e,i){"use strict";i(9)},9:function(t,e,i){"use strict";$("#chart").height(200);var a=echarts.init(document.getElementById("chart")),r={color:["#3398DB"],tooltip:{trigger:"axis",axisPointer:{type:"shadow"}},grid:{left:"3%",right:"4%",bottom:"3%",containLabel:!0},xAxis:[{type:"category",data:["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],axisTick:{alignWithLabel:!0}}],yAxis:[{type:"value"}],series:[{name:"直接访问",type:"bar",barWidth:"60%",data:[10,52,200,334,390,330,220]}]};a.setOption(r)}},[8]);