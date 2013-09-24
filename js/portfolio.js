/**
 * Copyright 2010 Steren Giannini steren.giannini@gmail.com
 * This script is licensed under GPLv3: modify it as long as you attribute and share it
 */

var filterGroups = ['seriousness', 'type', 'participation'];

/** The Work template */
var workTemplate = 	[
					'<a href="{{#link}}{{href}}{{/link}}" title="{{#link}}{{value}}{{/link}}" target="_blank" data-id="{{id}}" class="work seriousness:{{seriousness}} type:{{type}} participation:{{participation}}">',
					'<img class="icon" src="img/icons/{{id}}.png" alt="{{title}}"/>',
					'<p class="title">{{title}}</p>',
					'<p class="category">{{category}}</p>',
					'<p class="date">{{date}}</p>',
					'<p class="description">{{description}}</p>',
					//'{{#links}}',
					//	'<p class="link"><a href="{{href}}">{{value}}</a></p>',
					//'{{/links}}',
					'</a>'].join('');

/** two dimentional array containing current state (types[group][type]) */
var types = [];

/** data are sorted by */
var sortBy = 'date';

function filterClick(input) {
	// Get the group and type of the button clicked
	var groupAndType = input.target.id;
	groupAndType = groupAndType.split(':');
	var type = groupAndType[1];
	var typeGroup = groupAndType[0];

	// Change the value
	if (types[typeGroup][type] == 0) {
		types[typeGroup][type] = 1;
		$(input.target).addClass('active');
	} else {
		types[typeGroup][type] = 0; 
		$(input.target).removeClass('active');
	};
	refresh();
	return false;
}

function sortClick(input) {
	$(".sort").removeClass('active');
	$(input.target).addClass('active');
	sortBy = input.target.id;
	refresh();
	return false;
}

function refresh() {
	// sort depending on the sort option selected
	sortData();
	
	$('#worksTarget').html('');
	// iterate on every work
	for( var i =0; i < data.length; i++ ) {
		var work = data[i];
		// this array will contain the resutl value for every filter group
		var resultArray = [];

		// for each filter group
		for( var j = 0; j < filterGroups.length; j++ ) {
				var typeGroup = filterGroups[j];
				var type = work[typeGroup];
			
				if( resultArray[typeGroup] != null ) {
					resultArray[typeGroup] += types[typeGroup][type];
				} else {
					resultArray[typeGroup] = types[typeGroup][type];
				}
		}
		
		var result = 1;
		for( var val in resultArray ) {
			result *= resultArray[val];
		}
		
		if(result !== 0) {
			var html = Mustache.to_html(workTemplate, work);
			$('#worksTarget').append(html);
		}
	}
	
	$('#works').quicksand( $('#worksTarget a'), {useScaling: true});
}

function sortData() {
	data.sort(function(a, b) {
		reversed = true;
		var valA = a[sortBy];
		var valB = b[sortBy];
		if (reversed) {
		  return (valA < valB) ? 1 : (valA > valB) ? -1 : 0;				
		} else {		
		  return (valA < valB) ? -1 : (valA > valB) ? 1 : 0;	
		}
	});
}

$(document).ready(function() {

	$("#filters").fadeTo(0,0);

	// Populate types
	$(".filter").each( function(i, filter) {
		var groupAndType = filter.id.split(':');
		
		var type = groupAndType[1];
		var typeGroup = groupAndType[0];
		
		var value = $(filter).hasClass("active") ? 1 : 0;
		
		if(types[typeGroup] == null) {
			var group = [];
			group[type] = value;
			types[typeGroup] = group;
		} else {
			types[typeGroup][type]= value;
		}
	});
	

	// generate features works
	var etc = '<div class="etc"><a class="displayMore displayWorks" href="#">...</a></div>';

	var $works = $('#works');

	var wipTitle = '<h2>Work in progress (<a href="#" class="displayWorks">more</a>)</h2>';
	var finishedTitle = '<h2>Finished works (<a href="#" class="displayWorks">more</a>)</h2>';
	var featuredTitle = '<h2>Featured works: (<a href="#" class="displayWorks">click here to see more works</a>)</h2>';


	var wipTotal = 0;
	var finishedTotal = 0;
	var wipHTML = '';
	var finishedHTML = '';


	for(var i in data) {
		if(data[i].completion == 'wip' && data[i].featured) {
			wipTotal++;
			wipHTML += Mustache.to_html(workTemplate, data[i]);

		}
	}
	for(var j in data) {
		if(data[j].completion == 'done' && data[j].featured) {
			finishedTotal++;
			finishedHTML += Mustache.to_html(workTemplate, data[j]);
		}
	}

	if(wipTotal < 2) {
		$works.append(featuredTitle + wipHTML + finishedHTML);
	} else {
		$works.append(wipTitle + wipHTML + finishedTitle + finishedHTML);
	}


	

	$('.filter').click(filterClick);
	$('.sort').click(sortClick);

	$('.displayWorks').click( function() {
		$("#filters").fadeTo("normal",1);
		refresh();
		return false;
	});
	

});

